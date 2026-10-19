import { addDays, addMonths } from '../common/date';

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

export function advanceDate(
  date: Date,
  cadence: string,
  anchorDay?: number,
): Date {
  switch (cadence) {
    case 'weekly':
      return addDays(date, 7);
    case 'monthly':
      return addMonths(date, 1, anchorDay);
    case 'quarterly':
      return addMonths(date, 3, anchorDay);
    case 'yearly':
      return addMonths(date, 12, anchorDay);
    default:
      return new Date(date);
  }
}

export type SettleInput = {
  dueDate: Date | null;
  cadence: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  /** The day of the month the schedule is anchored to, so a bill due the 31st
   *  returns to the 31st after a short month. Null on reminders created before
   *  the column existed; then the current due date's day is used. */
  dueAnchorDay?: number | null;
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
        ? advanceDate(
            reminder.dueDate,
            reminder.cadence,
            reminder.dueAnchorDay ?? undefined,
          )
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
    const nextDue = advanceDate(
      reminder.dueDate,
      reminder.cadence,
      reminder.dueAnchorDay ?? undefined,
    );
    return { kind: 'recurring', data: { dueDate: nextDue }, nextDue };
  }

  return { kind: 'nothing-to-advance' };
}

/**
 * What deleting a reminder means, for the same two callers as planSettlement
 * (the web app's Delete and the Telegram nudge's Delete).
 *
 * A reminder read from a transaction is hidden, not removed: scan() treats a
 * transaction as already read only while some reminder row points at it, so
 * removing the row let the next scan read the line straight back into the
 * reminder just deleted. Done is set alongside deletedAt so every query for
 * open reminders — nudges, /due, reconcile, the scan's dedupe sets — skips it
 * without having to know deletion exists. One typed in by hand has no source a
 * scan could re-read, so it is removed outright.
 */
export type Deletion =
  | { kind: 'remove' }
  | { kind: 'hide'; data: { done: true; deletedAt: Date } };

export function planDeletion(
  reminder: { sourceTransactionId: string | null },
  now: Date,
): Deletion {
  return reminder.sourceTransactionId === null
    ? { kind: 'remove' }
    : { kind: 'hide', data: { done: true, deletedAt: now } };
}
