import type { RecurringCadence } from '@prisma/client';
import { addDays, addMonths } from '../common/date';

/**
 * The next occurrence date after `date`, advancing by `interval` cadence units.
 * All math is in UTC. For MONTHLY/YEARLY, `anchorDay` (the rule's start day of
 * month) keeps the schedule from drifting when a month is short: e.g. a rule on
 * the 31st lands on the 28th/30th in short months but returns to the 31st after.
 */
export function nextOccurrence(
  date: Date,
  cadence: RecurringCadence,
  interval: number,
  anchorDay?: number,
): Date {
  switch (cadence) {
    case 'DAILY':
      return addDays(date, interval);
    case 'WEEKLY':
      return addDays(date, interval * 7);
    case 'MONTHLY':
      return addMonths(date, interval, anchorDay);
    case 'YEARLY':
      return addMonths(date, interval * 12, anchorDay);
  }
}

/** Approximate number of occurrences per year, for annualized-cost estimates. */
export function occurrencesPerYear(
  cadence: RecurringCadence,
  interval: number,
): number {
  const perYear = { DAILY: 365, WEEKLY: 52, MONTHLY: 12, YEARLY: 1 }[cadence];
  return perYear / interval;
}
