/** Formats minor currency units (cents) for display, e.g. 12345 -> "€123.45". */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(cents / 100);
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

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
