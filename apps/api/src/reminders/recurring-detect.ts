/**
 * Deterministic recurring-bill detection (no LLM). Groups a user's Bills /
 * Subscriptions expenses by subcategory and flags the ones that repeat on a
 * clean monthly or quarterly cadence, so an upcoming-payment reminder can be
 * created for the next occurrence. Purely functional for easy testing.
 */

const DAY = 86_400_000;

// Obvious recurring bills qualify from a single occurrence — a first rent or
// travel-pass charge is clearly monthly before a pattern has formed.
const OBVIOUS_MONTHLY =
  /\b(rent|miete|deutschland\s?ticket|deutschlandticket|d-ticket)\b/i;

export type BillTxn = {
  id: string;
  subcategoryId: string;
  /** Subcategory name — used as the reminder label. */
  name: string;
  date: Date;
  /** Native minor units (cents). */
  amount: number;
  currency: string;
};

export type RecurringCandidate = {
  subcategoryId: string;
  label: string;
  amountCents: number;
  currency: string;
  cadence: 'monthly' | 'quarterly';
  nextDate: Date;
  /** The latest occurrence, anchoring the reminder. */
  sourceTransactionId: string;
};

/** One calendar month's worth of a subcategory's charges. */
type MonthBucket = { date: Date; total: number };

/** Recurring bills among `txns` (already limited to Bills/Subscriptions). */
export function detectRecurringBills(
  txns: BillTxn[],
  now: Date,
): RecurringCandidate[] {
  const groups = new Map<string, BillTxn[]>();
  for (const t of txns) {
    const list = groups.get(t.subcategoryId) ?? [];
    list.push(t);
    groups.set(t.subcategoryId, list);
  }

  const out: RecurringCandidate[] = [];
  for (const [subcategoryId, list] of groups) {
    const sorted = [...list].sort((a, b) => a.date.getTime() - b.date.getTime());
    const latest = sorted[sorted.length - 1];
    // Collapse to one point per calendar month, so a subcategory that lumps
    // several services (many charges a month, on different days) still reads as
    // a clean monthly recurrence, and the reminder shows the whole month's total.
    const months = monthBuckets(sorted);
    const cadence = inferCadence(months, latest.name);
    if (!cadence) continue;
    out.push({
      subcategoryId,
      label: latest.name,
      // The most recent month's total — right for both a single bill and a
      // lumped "all subscriptions" subcategory.
      amountCents: months[months.length - 1].total,
      currency: latest.currency,
      cadence,
      nextDate: nextAfter(latest.date, cadence, now),
      sourceTransactionId: latest.id,
    });
  }
  return out;
}

/** Collapses charges to one bucket per calendar month (earliest date, summed). */
function monthBuckets(sorted: BillTxn[]): MonthBucket[] {
  const byMonth = new Map<string, MonthBucket>();
  for (const t of sorted) {
    const key = `${t.date.getUTCFullYear()}-${t.date.getUTCMonth()}`;
    const bucket = byMonth.get(key);
    if (bucket) bucket.total += t.amount;
    else byMonth.set(key, { date: t.date, total: t.amount });
  }
  return [...byMonth.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * The cadence a subcategory repeats on, or null if it isn't a clean recurrence.
 * Works off one point per month; the ±5-day tolerance (for payments that slip
 * when a balance is short) is baked into the bands: monthly = 30±5, quarterly
 * = 90±5.
 */
function inferCadence(
  months: MonthBucket[],
  name: string,
): 'monthly' | 'quarterly' | null {
  if (months.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < months.length; i++) {
      intervals.push((months[i].date.getTime() - months[i - 1].date.getTime()) / DAY);
    }
    const med = median(intervals);
    if (med >= 25 && med <= 35) return 'monthly';
    if (med >= 85 && med <= 95) return 'quarterly';
  }
  if (OBVIOUS_MONTHLY.test(name)) return 'monthly';
  return null;
}

/** Steps `from` by `cadence` until the date is on/after `now`. */
function nextAfter(from: Date, cadence: 'monthly' | 'quarterly', now: Date): Date {
  const months = cadence === 'monthly' ? 1 : 3;
  const d = new Date(from);
  let guard = 0;
  do {
    d.setUTCMonth(d.getUTCMonth() + months);
  } while (d.getTime() < now.getTime() && guard++ < 240);
  return d;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
