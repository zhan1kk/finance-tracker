import { Logger } from '@nestjs/common';
import type {
  CategorizationInput,
  CategorizationPrediction,
  CategorizationProvider,
  SubcategoryLite,
} from '../types/import.types';
import {
  buildCategorizationPrompt,
  CATEGORIZATION_RESPONSE_SCHEMA,
  CATEGORIZATION_SYSTEM_PROMPT,
  coercePredictions,
} from './prompt';

// Local models have smaller context windows than a hosted one, so fewer rows
// per request keeps the prompt comfortably in range and accuracy steady.
//
// Measured on the 4-CPU server with qwen3:4b against ten labelled merchants
// (REWE, Netflix, Deutsche Bahn, Shell, McDonald's...), scoring correctness
// rather than merely whether an answer came back:
//   5 rows/call  -> 10/10 correct, 32s
//   8 rows/call  ->  8/10 correct, 32s
//   10 rows/call ->  4/10 correct, 38s   <- answers everything, 60% wrong
//   25 rows/call ->  1 answer for 25 rows, then it gives up
// Quality collapses long before the row count does, and ten is already the bad
// case: it fills in every row confidently and most are wrong, which is worse
// than returning nothing because it reads like success. Five is the size that
// is actually right, and it costs no more wall time per row.
const CHUNK_SIZE = 5;
// A cold local model (first load into memory) can take a while to respond.
const REQUEST_TIMEOUT_MS = 120_000;
// Ollama's default context (4k) has to hold the prompt AND the answer; give the
// reply room rather than letting a long chunk quietly truncate.
const NUM_CTX = 8192;
// Keep the model resident between chunks — an import is a burst of calls, and
// reloading 2.5GB from disk between each one dwarfs the inference itself.
const KEEP_ALIVE = '10m';

/**
 * Local LLM categorizer via Ollama's HTTP API (default http://localhost:11434).
 * Selected when CATEGORIZER=ollama. Transaction data never leaves the machine —
 * the privacy-preserving alternative to the hosted provider, and the second
 * data point for the thesis' local-vs-hosted accuracy comparison. Temperature 0
 * keeps categorizations reproducible. Any error yields null predictions for the
 * chunk (rows fall to manual review) so an import never fails because Ollama is
 * down or the model is not pulled.
 */
export class OllamaCategorizationProvider implements CategorizationProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaCategorizationProvider.name);

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): Promise<CategorizationPrediction[]> {
    const allowedIds = new Set(subcategories.map((s) => s.id));
    // Sequential on purpose (unlike the Anthropic provider): a local Ollama
    // serves one generation at a time by default, so parallel chunks would just
    // queue against each other and race the per-request timeout.
    const results: CategorizationPrediction[] = [];
    for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
      const chunk = inputs.slice(i, i + CHUNK_SIZE);
      results.push(
        ...(await this.categorizeChunk(chunk, subcategories, allowedIds)),
      );
    }
    return results;
  }

  private async categorizeChunk(
    chunk: CategorizationInput[],
    subcategories: SubcategoryLite[],
    allowedIds: Set<string>,
  ): Promise<CategorizationPrediction[]> {
    const fallback = chunk.map((c) => ({
      rowId: c.rowId,
      subcategoryId: null,
      confidence: 0,
    }));

    // Same aliasing as the Anthropic provider: small local models are even
    // easier to derail with 64-char ids to copy verbatim, and shorter replies
    // generate faster.
    const aliased = chunk.map((c, i) => ({ ...c, rowId: String(i + 1) }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // qwen3 and other hybrid models reason before answering unless told
          // not to. On CPU that is most of the cost: a prompt as trivial as
          // "reply with the word ok" spent 637 characters thinking and 16s.
          // Every categorization call used to blow its two-minute budget this
          // way, and the whole import fell back to "needs review".
          think: false,
          keep_alive: KEEP_ALIVE,
          format: CATEGORIZATION_RESPONSE_SCHEMA,
          options: { temperature: 0, num_ctx: NUM_CTX },
          messages: [
            { role: 'system', content: CATEGORIZATION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildCategorizationPrompt(aliased, subcategories),
            },
          ],
        }),
      });

      if (!res.ok) {
        this.logger.error(`Ollama categorization failed: HTTP ${res.status}`);
        return fallback;
      }

      // Non-streaming /api/chat returns { message: { content: "<json string>" } }.
      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data.message?.content;
      if (typeof content !== 'string') return fallback;

      const items = (JSON.parse(content) as { items?: unknown }).items;
      // Predictions come back in aliased-chunk order; restore the real row ids.
      return coercePredictions(items, aliased, allowedIds).map((p, i) => ({
        ...p,
        rowId: chunk[i].rowId,
      }));
    } catch (err) {
      this.logger.error(
        `Ollama categorization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
}
