/**
 * Pure currency-conversion helpers (no I/O), shared by the service and tests.
 *
 * A rate is "foreign units per 1 base unit" — e.g. currency "KZT" with rate 540
 * means 540 KZT = 1 EUR. Amounts are always integer minor units (cents/tiyn).
 */

/** The reporting currency everything is aggregated in. */
export const BASE_CURRENCY = 'EUR';

/**
 * Built-in fallback rates (foreign units per 1 EUR), used for any date not
 * covered by a user-set or synced rate. Rough seeds only — the real values come
 * from a rate sync or a manual entry; these just avoid a 1:1 crash pre-sync.
 */
export const DEFAULT_RATES: Record<string, number> = { KZT: 540, USD: 1.08 };

/**
 * Seed suggestions only. Which currencies a user actually tracks lives in their
 * CurrencyPreference rows — this list must never decide that, or every user
 * inherits one person's currencies.
 */
export const FOREIGN_CURRENCIES = Object.keys(DEFAULT_RATES);

/** A syntactically valid ISO-4217-style code; existence is proven by fetching. */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/** Currencies the UI offers for accounts (base first). */
export const SUPPORTED_CURRENCIES = [BASE_CURRENCY, ...FOREIGN_CURRENCIES];

/** Max exchange-fee percentage a user can set — a guard against fat-finger 50s. */
export const MAX_SPREAD_PCT = 10;

export type RatePoint = { date: Date; rate: number };

/**
 * Applies an exchange fee to a mid-market rate (foreign per 1 EUR). A 2% fee
 * means 1 EUR buys ~2% fewer foreign units — your effective buy rate — so
 * foreign amounts convert to slightly more base currency (the fee is included
 * in what your money cost you). Clamped to a sane range.
 */
export function applySpread(midRate: number, spreadPct: number): number {
  const pct = Math.min(Math.max(spreadPct, 0), MAX_SPREAD_PCT);
  return midRate * (1 - pct / 100);
}

/**
 * The rate in effect for `currency` on `date`: the most recent user-set rate
 * dated on or before it, else the built-in default, else 1 (unknown currency —
 * treated 1:1 rather than crashing). `sorted` must be ascending by date.
 */
export function pickRate(
  sorted: RatePoint[],
  date: Date,
  currency: string,
): number {
  if (currency === BASE_CURRENCY) return 1;
  let chosen = DEFAULT_RATES[currency] ?? 1;
  const at = date.getTime();
  for (const point of sorted) {
    if (point.date.getTime() <= at) chosen = point.rate;
    else break;
  }
  return chosen;
}

/** Converts a minor-unit `amount` in `currency` to base-currency minor units. */
export function toBase(amount: number, currency: string, rate: number): number {
  if (currency === BASE_CURRENCY) return amount;
  return Math.round(amount / rate);
}
