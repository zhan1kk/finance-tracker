export type ParsedCapture = {
  type: 'INCOME' | 'EXPENSE';
  /** Minor currency units (cents), always positive. */
  amountCents: number;
  /** The word the user typed to pick a subcategory. */
  categoryQuery: string;
  description?: string;
};

/**
 * Parses the strict v1 capture format: `<amount> <category> [description…]`,
 * with a `+` prefix for income. Examples:
 *   "12.50 groceries lunch stuff" -> EXPENSE 1250 "groceries" "lunch stuff"
 *   "+2000 salary"                -> INCOME 200000 "salary"
 */
export function parseCapture(text: string): ParsedCapture | null {
  const match = /^(\+?)(\d+(?:[.,]\d{1,2})?)\s+(\S+)(?:\s+(.+))?$/.exec(
    text.trim(),
  );
  if (!match) {
    return null;
  }
  const [, plus, rawAmount, categoryQuery, description] = match;
  const amountCents = Math.round(parseFloat(rawAmount.replace(',', '.')) * 100);
  if (amountCents <= 0) {
    return null;
  }
  return {
    type: plus ? 'INCOME' : 'EXPENSE',
    amountCents,
    categoryQuery,
    description: description?.trim() || undefined,
  };
}

export type CategoryMatch<T> =
  | { match: T; ambiguous?: never }
  | { match?: never; ambiguous: string[] };

/**
 * Fuzzy subcategory match: exact name, then unique prefix, then unique
 * substring (all case-insensitive). Multiple candidates at a tier are
 * reported back instead of guessing.
 */
export function matchSubcategory<T extends { name: string }>(
  subcategories: T[],
  query: string,
): CategoryMatch<T> {
  const q = query.toLowerCase();
  const tiers = [
    (name: string) => name === q,
    (name: string) => name.startsWith(q),
    (name: string) => name.includes(q),
  ];
  for (const matches of tiers) {
    const pool = subcategories.filter((s) => matches(s.name.toLowerCase()));
    if (pool.length === 1) {
      return { match: pool[0] };
    }
    if (pool.length > 1) {
      return { ambiguous: pool.map((s) => s.name) };
    }
  }
  return { ambiguous: [] };
}
