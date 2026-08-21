/** Formats minor currency units (cents) for display, e.g. 12345 -> "€123.45". */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/** Compact form for axis ticks, e.g. 250000 -> "€2.5K". */
export function formatCentsCompact(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/**
 * A stored calendar date — a transaction's day, a bill's due date — rendered as
 * "21 Aug 2026". These are serialized as UTC midnight, so they must be read back
 * in UTC: read locally, every date shows a day early for anyone west of
 * Greenwich. Pass `opts` to drop the year or lengthen the month.
 */
export function formatDate(
  iso: string,
  opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
): string {
  return new Date(iso).toLocaleDateString(undefined, {
    ...opts,
    timeZone: "UTC",
  });
}

/**
 * A moment in time — when an import ran — rendered in the reader's own timezone,
 * which is the opposite of formatDate: an import made at 01:30 in Berlin
 * happened on that day for the person who made it, whatever UTC says.
 */
export function formatTimestamp(
  iso: string,
  opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
): string {
  return new Date(iso).toLocaleDateString(undefined, opts);
}

/** Parses user input like "12.34" into cents. Returns null when invalid. */
export function parseAmountToCents(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const cents = Math.round(parseFloat(normalized) * 100);
  return cents > 0 ? cents : null;
}

/**
 * Like parseAmountToCents but allows zero and a leading minus — for starting
 * balances, where "-478.42" is a credit card's opening debt.
 */
export function parseSignedAmountToCents(input: string): number | null {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const normalized = (negative ? trimmed.slice(1) : trimmed)
    .trim()
    .replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const cents = Math.round(parseFloat(normalized) * 100);
  return negative ? -cents : cents;
}

/** Today's calendar date in the user's local timezone (UTC would date
 *  late-evening entries "yesterday" for anyone east of Greenwich). */
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
