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

/**
 * Swaps real subcategory UUIDs for short numbers before they go in the prompt.
 *
 * Row ids were already aliased for exactly this reason; the subcategory ids were
 * not, and that was worse. To name a category the model had to reproduce one
 * 36-character UUID exactly, chosen from sixty of them. Small models do not do
 * that reliably: qwen2.5:7b answered every row in a batch with the same id,
 * which surfaced as every transaction landing in one arbitrary category with
 * high confidence. Given "1".."61" instead, the same model on the same batch
 * separates Groceries, Netflix, Shopping and Dining Out correctly.
 *
 * The map back is applied in coercePredictions, so an alias the model invents is
 * rejected by the same allowed-id check as any other bad value.
 */
export function aliasSubcategories(subcategories: SubcategoryLite[]): {
  aliased: SubcategoryLite[];
  realIdFor: Map<string, string>;
} {
  const realIdFor = new Map<string, string>();
  // Prefixed, because row ids in the same prompt are already "1".."N". Sharing
  // that namespace means a model echoing a row number into subcategoryId lands
  // on a real but arbitrary category and passes validation, instead of failing
  // to resolve and falling to review where it belongs.
  const aliased = subcategories.map((s, i) => {
    const alias = `c${i + 1}`;
    realIdFor.set(alias, s.id);
    return { ...s, id: alias };
  });
  return { aliased, realIdFor };
}

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
  /** Alias -> real subcategory id, when the prompt used aliases. */
  realIdFor?: Map<string, string>,
): CategorizationPrediction[] {
  const fallback = () =>
    chunk.map((c) => ({
      rowId: c.rowId,
      subcategoryId: null,
      confidence: 0,
    }));
  if (!Array.isArray(items)) return fallback();

  const read = (item: Record<string, unknown>) => {
    const rawId = item?.subcategoryId;
    // Translate the alias first, then validate: an alias the model invented
    // maps to nothing and falls through the same allowed-id check as a
    // hallucinated UUID would.
    const resolved =
      typeof rawId === 'string' ? (realIdFor?.get(rawId) ?? rawId) : undefined;
    const subcategoryId =
      typeof resolved === 'string' && allowedIds.has(resolved)
        ? resolved
        : null;
    const confidence =
      typeof item?.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0;
    return { subcategoryId, confidence };
  };

  const list = items as Record<string, unknown>[];
  const byRow = new Map<string, CategorizationPrediction>();
  for (const item of list) {
    const rowId = typeof item?.rowId === 'string' ? item.rowId : null;
    if (!rowId) continue;
    byRow.set(rowId, { rowId, ...read(item) });
  }

  // Small local models are unreliable at echoing an identifier back. Observed
  // from qwen3:4b, given rows aliased "1".."5": one call answered with
  // rowId "description", another with "id_1"/"id_2" — while the categories it
  // chose were correct. Matching on rowId alone threw all of that away and the
  // whole chunk fell to "needs review", which read as the model being useless
  // when it had actually got the answers right.
  //
  // So: trust explicit ids when they line up, and otherwise fall back to
  // position, but only when the model returned exactly one item per row. A
  // length mismatch means it skipped or invented rows, and lining those up by
  // position would assign real categories to the wrong transactions — worse
  // than leaving them for review.
  const matched = chunk.filter((c) => byRow.has(c.rowId)).length;
  const alignByIndex = matched === 0 && list.length === chunk.length;

  return chunk.map((c, i) => {
    if (alignByIndex) return { rowId: c.rowId, ...read(list[i]) };
    return (
      byRow.get(c.rowId) ?? {
        rowId: c.rowId,
        subcategoryId: null,
        confidence: 0,
      }
    );
  });
}
