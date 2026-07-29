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
const CHUNK_SIZE = 25;
// A cold local model (first load into memory) can take a while to respond.
const REQUEST_TIMEOUT_MS = 120_000;

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
          format: CATEGORIZATION_RESPONSE_SCHEMA,
          options: { temperature: 0 },
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
