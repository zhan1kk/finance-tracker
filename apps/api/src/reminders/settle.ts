/**
 * What "settling" a reminder means, in one place.
 *
 * There are two ways to settle one — the web app's Paid button and the
 * Telegram nudge's ✓ button — and they used to decide independently. Telegram
 * just wrote `done: true`, so pressing ✓ on an installment plan dismissed the
 * whole plan instead of recording that payment and moving to the next one.
 * Both callers now ask this function, so they cannot drift apart again.
 *
 * Pure: it reads a reminder's fields and returns the update to apply, leaving
 * the database call to the caller.
 */

/** Cadences a plain (non-installment) recurring reminder rolls forward on. */
export const RECURRING_CADENCES = new Set([
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
]);

/**
 * Adds whole months, clamping to the end of the target month.
 *
 * Plain setUTCMonth() overflows: a bill due the 31st advanced by a month
 * becomes "31 February", which JS silently rolls into March — so the reminder
 * skips a month entirely and then nags on the wrong date forever after. Due the
 * 31st means the 30th in a 30-day month, and the 28th (or 29th) in February.
 */
function addMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const d = new Date(date);
  // Move off the day-of-month first, so changing the month cannot overflow.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfMonth));
  return d;
}

export function advanceDate(date: Date, cadence: string): Date {
  switch (cadence) {
    case 'weekly': {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    }
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'yearly':
      return addMonths(date, 12);
    default:
      return new Date(date);
  }
}

export type SettleInput = {
  dueDate: Date | null;
  cadence: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
};

export type Settlement =
  /** One payment of a fixed plan; `finished` once the last one is in. */
  | {
      kind: 'installment';
      data: { installmentsPaid: number; done: boolean; dueDate: Date | null };
      paid: number;
      total: number;
      finished: boolean;
      nextDue: Date | null;
    }
  /** A recurring bill: rolls forward and stays open, so it nags next cycle. */
  | { kind: 'recurring'; data: { dueDate: Date }; nextDue: Date }
  /** A one-off with nothing to advance — the only case where done: true fits. */
  | { kind: 'nothing-to-advance' };

export function planSettlement(reminder: SettleInput): Settlement {
  if (reminder.installmentsTotal != null) {
    const total = reminder.installmentsTotal;
    const paid = Math.min((reminder.installmentsPaid ?? 0) + 1, total);
    const finished = paid >= total;
    // Advance to the next payment date unless we're finished.
    const dueDate =
      !finished && reminder.dueDate && reminder.cadence
        ? advanceDate(reminder.dueDate, reminder.cadence)
        : reminder.dueDate;
    return {
      kind: 'installment',
      data: { installmentsPaid: paid, done: finished, dueDate },
      paid,
      total,
      finished,
      nextDue: finished ? null : dueDate,
    };
  }

  if (
    reminder.dueDate &&
    reminder.cadence &&
    RECURRING_CADENCES.has(reminder.cadence)
  ) {
    const nextDue = advanceDate(reminder.dueDate, reminder.cadence);
    return { kind: 'recurring', data: { dueDate: nextDue }, nextDue };
  }

  return { kind: 'nothing-to-advance' };
}
