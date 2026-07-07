export type DateFormat = 'ISO' | 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY';

export const DATE_FORMATS: DateFormat[] = [
  'ISO',
  'DD.MM.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
];

/**
 * Parses a statement amount into **signed** minor units (cents). Handles a
 * leading minus, accounting parentheses for negatives, currency symbols,
 * thousands separators, and a `,` or `.` decimal separator. Returns null when
 * the value is not a number.
 */
export function parseAmount(
  raw: string,
  decimalSeparator: '.' | ',' = '.',
): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const negative = /^-/.test(trimmed) || /^\(.*\)$/.test(trimmed);

  let digits = trimmed.replace(/[^0-9.,]/g, '');
  if (decimalSeparator === ',') {
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/,/g, '');
  }
  if (digits === '' || digits === '.') return null;

  const value = Number.parseFloat(digits);
  if (Number.isNaN(value)) return null;

  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** Parses a date string in a known format into a UTC-midnight Date, or null. */
export function parseDate(raw: string, format: DateFormat): Date | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (format === 'ISO') {
    // Accept "YYYY-MM-DD" (anchored to UTC) and full ISO timestamps.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
      return utcDate(+dateOnly[1], +dateOnly[2], +dateOnly[3]);
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const sep = format === 'DD.MM.YYYY' ? '.' : '/';
  const parts = trimmed.split(sep);
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;

  const [a, b, y] = nums;
  const [day, month] = format === 'MM/DD/YYYY' ? [b, a] : [a, b];
  return utcDate(y, month, day);
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow (e.g. 31 Feb rolling into March).
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}
