/**
 * Pure currency-conversion helpers (no I/O), shared by the service and tests.
 *
 * A rate is "foreign units per 1 base unit" — e.g. currency "KZT" with rate 540
 * means 540 KZT = 1 EUR. Amounts are always integer minor units (cents/tiyn).
 */

/** The reporting currency everything is aggregated in. */
export const BASE_CURRENCY = 'EUR';

/**
 * Built-in fallback rates, used for any date not covered by a user-set rate.
 * The user overrides these per-date via /fx/rates or the Telegram /rate command.
 */
export const DEFAULT_RATES: Record<string, number> = { KZT: 540 };

/** Currencies the UI offers for accounts (base first). */
export const SUPPORTED_CURRENCIES = [BASE_CURRENCY, ...Object.keys(DEFAULT_RATES)];

export type RatePoint = { date: Date; rate: number };

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
