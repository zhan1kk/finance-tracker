import type {
  CategorizationInput,
  CategorizationPrediction,
  SubcategoryLite,
} from '../types/import.types';

/**
 * Instruction shared by every LLM categorizer (Anthropic, Ollama), so a change
 * in categorization behaviour is made in one place and the providers stay
 * comparable — which matters when the thesis measures one model against another.
 */
export const CATEGORIZATION_SYSTEM_PROMPT =
  "You categorize bank/card transactions into a fixed list of the user's " +
  'subcategories. For each transaction, choose the single best subcategory id ' +
  'from the provided list, or null if none is a reasonable fit. Also return a ' +
  'confidence between 0 and 1 reflecting how certain you are. Prefer null with ' +
  'low confidence over a wrong guess. Use only ids from the list.';

/**
 * The single output contract every LLM provider is held to: one item per
 * transaction, nothing else. Claude receives it as a forced tool `input_schema`
 * and Ollama as its structured-output `format`, so both return the identical
 * shape — which leaves the model as the only variable between them (keeping the
 * thesis' local-vs-hosted accuracy comparison apples-to-apples). Adherence only;
 * coercePredictions still validates the result, since a schema cannot stop a
 * model from returning a syntactically valid but non-existent subcategory id.
 */
export const CATEGORIZATION_RESPONSE_SCHEMA = {
  // `as const` keeps the top-level `type` a literal for Claude's InputSchema;
  // the nested shape sits under `properties`, which both SDKs treat as opaque.
  type: 'object' as const,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rowId: { type: 'string' },
          subcategoryId: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['rowId', 'subcategoryId', 'confidence'],
      },
    },
  },
  required: ['items'],
};

/** Renders the subcategory list + a chunk of transactions as the user prompt. */
export function buildCategorizationPrompt(
  chunk: CategorizationInput[],
  subcategories: SubcategoryLite[],
): string {
  const cats = subcategories
    .map((s) => `- ${s.id} — ${s.name} (${s.category})`)
    .join('\n');
  const rows = chunk
    .map(
      (c) =>
        `- rowId ${c.rowId}: ${c.type} ${(c.amount / 100).toFixed(2)} — "${c.description}"`,
    )
    .join('\n');
  return `Subcategories:\n${cats}\n\nTransactions:\n${rows}`;
}

/**
 * Turns a model's raw `items` array into exactly one prediction per input row.
 * Every provider funnels its output through here so untrusted model output is
 * validated identically: an id the user does not own (or a hallucinated one)
 * becomes null, confidence is clamped to 0..1, and any row the model skipped or
 * duplicated falls back to null/0. Never throws.
 */
export function coercePredictions(
  items: unknown,
  chunk: CategorizationInput[],
  allowedIds: Set<string>,
): CategorizationPrediction[] {
  const fallback = () =>
    chunk.map((c) => ({
      rowId: c.rowId,
      subcategoryId: null,
      confidence: 0,
    }));
  if (!Array.isArray(items)) return fallback();

  const byRow = new Map<string, CategorizationPrediction>();
  for (const item of items as Record<string, unknown>[]) {
    const rowId = typeof item?.rowId === 'string' ? item.rowId : null;
    if (!rowId) continue;
    const rawId = item.subcategoryId;
    const subcategoryId =
      typeof rawId === 'string' && allowedIds.has(rawId) ? rawId : null;
    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0;
    byRow.set(rowId, { rowId, subcategoryId, confidence });
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
