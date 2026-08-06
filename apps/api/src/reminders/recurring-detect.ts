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
    const cadence = inferCadence(sorted, latest);
    if (!cadence) continue;
    out.push({
      subcategoryId,
      label: latest.name,
      amountCents: latest.amount,
      currency: latest.currency,
      cadence,
      nextDate: nextAfter(latest.date, cadence, now),
      sourceTransactionId: latest.id,
    });
  }
  return out;
}

/**
 * The cadence a group repeats on, or null if it isn't a clean recurrence. The
 * ±5-day tolerance (for payments that slip when a balance is short) is baked
 * into the interval bands: monthly = 30±5, quarterly = 90±5.
 */
function inferCadence(
  sorted: BillTxn[],
  latest: BillTxn,
): 'monthly' | 'quarterly' | null {
  if (sorted.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY);
    }
    const med = median(intervals);
    if (med >= 25 && med <= 35) return 'monthly';
    if (med >= 85 && med <= 95) return 'quarterly';
  }
  if (OBVIOUS_MONTHLY.test(latest.name)) return 'monthly';
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
