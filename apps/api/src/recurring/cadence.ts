import type { RecurringCadence } from '@prisma/client';

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

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date: Date, months: number, anchorDay?: number): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = anchorDay ?? date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
}

/** Approximate number of occurrences per year, for annualized-cost estimates. */
export function occurrencesPerYear(
  cadence: RecurringCadence,
  interval: number,
): number {
  const perYear = { DAILY: 365, WEEKLY: 52, MONTHLY: 12, YEARLY: 1 }[cadence];
  return perYear / interval;
}
