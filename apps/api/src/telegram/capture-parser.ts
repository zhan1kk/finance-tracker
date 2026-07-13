import { parseDate } from '../imports/parsing';

export type ParsedCapture = {
  type: 'INCOME' | 'EXPENSE';
  /** Minor currency units (cents), always positive. */
  amountCents: number;
  /** What the user typed to pick a subcategory (may be multi-word). */
  categoryQuery: string;
  description?: string;
  /** ISO date (YYYY-MM-DD); omitted means "today". */
  date?: string;
};

const AMOUNT = /^(\+?)(\d+(?:[.,]\d{1,2})?)$/;
/** Fields are separated by a dash with whitespace around it, so hyphenated
 *  words ("e-bike") and ISO dates ("2026-07-09") survive intact. */
const SEPARATOR = /\s+-\s+/;

/**
 * Parses the dash-separated capture format:
 *   `<amount> - <category> [- <description>] [- <date>]`
 * Examples:
 *   "12.50 - groceries"
 *   "40 - dining out - lunch with friends"
 *   "40 - dining out - lunch - 09.07"       (DD.MM, current year)
 *   "+2000 - salary - july - 2026-07-01"
 * The category may be multi-word (this replaced the old whitespace format,
 * where "dining out" parsed as category "dining" + description "out").
 */
export function parseCapture(text: string): ParsedCapture | null {
  const segments = text
    .trim()
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length < 2) {
    return null;
  }

  const amountMatch = AMOUNT.exec(segments[0]);
  if (!amountMatch) {
    return null;
  }
  const [, plus, rawAmount] = amountMatch;
  const amountCents = Math.round(parseFloat(rawAmount.replace(',', '.')) * 100);
  if (amountCents <= 0) {
    return null;
  }

  const rest = segments.slice(2);
  let date: string | undefined;
  if (rest.length > 0) {
    const candidate = parseCaptureDate(rest[rest.length - 1]);
    if (candidate) {
      date = candidate;
      rest.pop();
    }
  }

  return {
    type: plus ? 'INCOME' : 'EXPENSE',
    amountCents,
    categoryQuery: segments[1],
    description: rest.join(' - ') || undefined,
    date,
  };
}

/** "2026-07-09", "09.07.2026" or "09.07" (current year) → ISO date, else null. */
export function parseCaptureDate(raw: string): string | null {
  const t = raw.trim();
  let parsed: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    parsed = parseDate(t, 'ISO');
  } else if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t)) {
    parsed = parseDate(t, 'DD.MM.YYYY');
  } else if (/^\d{1,2}\.\d{1,2}$/.test(t)) {
    parsed = parseDate(`${t}.${new Date().getUTCFullYear()}`, 'DD.MM.YYYY');
  }
  return parsed ? parsed.toISOString().slice(0, 10) : null;
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
