/**
 * Deterministic recurring-bill detection (no LLM). Groups a user's Bills /
 * Subscriptions expenses by subcategory and flags the ones that repeat on a
 * clean monthly or quarterly cadence, so an upcoming-payment reminder can be
 * created for the next occurrence. Purely functional for easy testing.
 */

import { extractInstallment } from './reminder-prompt';

const DAY = 86_400_000;

type Cadence = 'monthly' | 'quarterly' | 'yearly';

export type BillTxn = {
  id: string;
  subcategoryId: string;
  /** Subcategory name — used as the reminder label. */
  name: string;
  date: Date;
  /** Native minor units (cents). */
  amount: number;
  currency: string;
  /** The row's description — read for an "N/M" installment marker. */
  description: string | null;
};

export type RecurringCandidate = {
  subcategoryId: string;
  label: string;
  amountCents: number;
  currency: string;
  cadence: Cadence;
  nextDate: Date;
  /** The latest occurrence, anchoring the reminder. */
  sourceTransactionId: string;
  /** Set when the anchor's description marks a limited plan ("N/M"). */
  installmentsTotal: number | null;
  installmentsPaid: number | null;
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
    const sorted = [...list].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
    const latest = sorted[sorted.length - 1];
    // Collapse to one point per calendar month, so a subcategory that lumps
    // several services (many charges a month, on different days) still reads as
    // a clean monthly recurrence, and the reminder shows the whole month's total.
    const months = monthBuckets(sorted);
    const cadence = inferCadence(months);
    if (!cadence) continue;
    // If the anchor's description marks a limited plan ("3/12"), surface it as an
    // installment reminder (progress + auto-complete) rather than open-ended.
    const inst = extractInstallment(latest.description);
    // A fully-paid plan ("3/3") has nothing left to remind about.
    if (inst && inst.paid >= inst.total) continue;
    out.push({
      subcategoryId,
      label: latest.name,
      // The most recent COMPLETE month's total — right for a single bill and,
      // for a lumped "all subscriptions" subcategory, avoids understating the
      // amount from an in-progress current month that only has some charges so
      // far. Falls back to the latest month if that's all there is.
      amountCents: representativeAmount(months, now),
      currency: latest.currency,
      cadence,
      // One period after the last recorded charge — NOT stepped into the future.
      // If that date is already past (a payment fell due but isn't imported yet),
      // it surfaces as overdue instead of being skipped.
      nextDate: nextOccurrence(latest.date, cadence),
      sourceTransactionId: latest.id,
      installmentsTotal: inst?.total ?? null,
      installmentsPaid: inst?.paid ?? null,
    });
  }
  return out;
}

/**
 * The total to show for the reminder: the most recent month that isn't the
 * current (still in-progress) calendar month, so a lumped subcategory reflects a
 * full month's charges rather than a partial one. Falls back to the latest month
 * when every charge is in the current month (e.g. a first Rent charge).
 */
function representativeAmount(months: MonthBucket[], now: Date): number {
  const currentKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  const complete = months.filter(
    (m) => `${m.date.getUTCFullYear()}-${m.date.getUTCMonth()}` !== currentKey,
  );
  const pick = complete.length ? complete : months;
  return pick[pick.length - 1].total;
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
  return [...byMonth.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
}

/**
 * The cadence a subcategory repeats on, or null if it isn't a clean recurrence.
 * Purely pattern-based (no hardcoded bill names, so it generalizes to any
 * user): it needs at least two months of history. Works off one point per
 * month; the ±5-day tolerance (for payments that slip when a balance is short)
 * is baked into the bands: monthly = 30±5, quarterly = 90±5.
 */
function inferCadence(months: MonthBucket[]): Cadence | null {
  if (months.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < months.length; i++) {
    intervals.push(
      (months[i].date.getTime() - months[i - 1].date.getTime()) / DAY,
    );
  }
  const med = median(intervals);
  if (med >= 25 && med <= 35) return 'monthly';
  if (med >= 85 && med <= 95) return 'quarterly';
  // Yearly: ~365 days, wide tolerance for month-length drift and leap years.
  if (med >= 350 && med <= 380) return 'yearly';
  return null;
}

/** The next expected occurrence: a single step from `from`, so a payment that
 * fell due before today (but isn't recorded yet) shows as overdue rather than
 * being rolled forward to a future date. */
function nextOccurrence(from: Date, cadence: Cadence): Date {
  const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
