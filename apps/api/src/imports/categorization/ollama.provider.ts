import { OLLAMA_KEEP_ALIVE } from '../../common/ollama';
import { Logger } from '@nestjs/common';
import type {
  CategorizationInput,
  CategorizationPrediction,
  CategorizationProvider,
  SubcategoryLite,
} from '../types/import.types';
import {
  aliasSubcategories,
  buildCategorizationPrompt,
  buildParentPrompt,
  PARENT_SYSTEM_PROMPT,
  CATEGORIZATION_RESPONSE_SCHEMA,
  CATEGORIZATION_SYSTEM_PROMPT,
  coercePredictions,
} from './prompt';

// Local models have smaller context windows than a hosted one, so fewer rows
// per request keeps the prompt comfortably in range and accuracy steady.
//
// Measured on the 4-CPU server with qwen3:4b against fifteen labelled merchants
// (REWE, Netflix, Deutsche Bahn, Shell, McDonald's...), scoring correctness
// rather than whether an answer merely came back, and with the positional
// fallback in coercePredictions already in place:
//   5 rows/call  -> 15/15 correct, 0 unanswered, 50s
//   10 rows/call ->  5/15 correct, 10 unanswered, 32s
//   15 rows/call -> 13/15 correct, 0 unanswered, 49s
// Ten is not a midpoint between five and fifteen — the model's reliability at
// this is erratic above five rather than smoothly degrading, and the run-to-run
// spread is wide. Five was perfect on every attempt and costs little extra wall
// time, since the per-call overhead dominates. Roughly five minutes for a
// hundred rows, which is fine for a background import.
const CHUNK_SIZE = 5;
// A cold local model (first load into memory) can take a while to respond.
const REQUEST_TIMEOUT_MS = 120_000;
// Ollama's default context (4k) has to hold the prompt AND the answer; give the
// reply room rather than letting a long chunk quietly truncate.
const NUM_CTX = 8192;

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
        ...(await this.categorizeChunkTwoStage(
          chunk,
          subcategories,
          allowedIds,
        )),
      );
    }
    return results;
  }

  /**
   * Narrows the candidate list before asking for a subcategory.
   *
   * A local model cannot pick one of sixty; measured, it answers the same id for
   * every row in the batch. Asking which of six parent categories a row belongs
   * to is easy, and the follow-up question then offers only that parent's
   * subcategories, which is a list short enough to answer well.
   *
   * A row whose parent cannot be determined falls through to null rather than
   * being guessed against the full list, since that is what produced confident
   * nonsense before.
   */
  private async categorizeChunkTwoStage(
    chunk: CategorizationInput[],
    subcategories: SubcategoryLite[],
    allowedIds: Set<string>,
  ): Promise<CategorizationPrediction[]> {
    const nullFor = (rows: CategorizationInput[]) =>
      rows.map((c) => ({ rowId: c.rowId, subcategoryId: null, confidence: 0 }));

    // Only parents that can apply: an expense row is never Income, and offering
    // it anyway is how "ALDI SUED" became "K's salary".
    const parentsFor = (row: CategorizationInput) =>
      [...new Set(subcategories.map((s) => s.category))].filter((c) =>
        row.type === 'INCOME' ? c === 'Income' : c !== 'Income',
      );

    const parents = parentsFor(chunk[0]);
    if (parents.length === 0) return nullFor(chunk);

    const parentOf = await this.pickParents(chunk, parents);

    // Ask once per parent, with only that parent's subcategories on the table.
    const byRow = new Map<string, CategorizationPrediction>();
    for (const parent of parents) {
      const rows = chunk.filter((c) => parentOf.get(c.rowId) === parent);
      if (rows.length === 0) continue;
      const subs = subcategories.filter((s) => s.category === parent);
      if (subs.length === 0) continue;
      for (const p of await this.categorizeChunk(rows, subs, allowedIds)) {
        byRow.set(p.rowId, p);
      }
    }

    return chunk.map(
      (c) =>
        byRow.get(c.rowId) ?? {
          rowId: c.rowId,
          subcategoryId: null,
          confidence: 0,
        },
    );
  }

  /** Stage one: which broad category is each row? Returns rowId -> parent. */
  private async pickParents(
    chunk: CategorizationInput[],
    parents: string[],
  ): Promise<Map<string, string>> {
    const aliased = chunk.map((c, i) => ({ ...c, rowId: String(i + 1) }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const chosen = new Map<string, string>();
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: CATEGORIZATION_RESPONSE_SCHEMA,
          options: { temperature: 0, num_ctx: NUM_CTX },
          messages: [
            { role: 'system', content: PARENT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildParentPrompt(aliased, parents),
            },
          ],
        }),
      });
      if (!res.ok) return chosen;
      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data.message?.content;
      if (typeof content !== 'string') return chosen;
      const items = (JSON.parse(content) as { items?: unknown }).items;
      if (!Array.isArray(items)) return chosen;
      items.forEach((raw, i) => {
        const item = raw as Record<string, unknown>;
        const alias =
          typeof item?.subcategoryId === 'string' ? item.subcategoryId : null;
        const index = alias ? Number(alias.replace(/^p/, '')) : NaN;
        const parent = parents[index - 1];
        // Same positional fallback as the subcategory stage: the model is
        // unreliable at echoing an id, so when nothing matches but the counts
        // line up, order is the only thing left to trust.
        const row = chunk[i];
        if (parent && row) chosen.set(row.rowId, parent);
      });
      return chosen;
    } catch (err) {
      this.logger.error(
        `Ollama parent stage failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return chosen;
    } finally {
      clearTimeout(timer);
    }
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
    // Category ids are aliased for the same reason as row ids: a local model
    // asked to copy a UUID verbatim tends to repeat one for the whole batch.
    const { aliased: aliasedSubs, realIdFor } =
      aliasSubcategories(subcategories);

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
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: CATEGORIZATION_RESPONSE_SCHEMA,
          options: { temperature: 0, num_ctx: NUM_CTX },
          messages: [
            { role: 'system', content: CATEGORIZATION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildCategorizationPrompt(aliased, aliasedSubs),
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
      return coercePredictions(items, aliased, allowedIds, realIdFor).map(
        (p, i) => ({
          ...p,
          rowId: chunk[i].rowId,
        }),
      );
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
