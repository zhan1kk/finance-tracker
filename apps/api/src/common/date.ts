/**
 * Calendar month arithmetic, in UTC.
 *
 * Plain `setUTCMonth()` overflows: 31 January plus a month becomes "31
 * February", which rolls into March — so a schedule on the 31st skips a month
 * entirely. Clamping alone is not enough either, because the clamped date
 * becomes the new starting point and the schedule sags a few days earlier every
 * time it passes a short month.
 *
 * Passing the original day of the month as `anchorDay` fixes both: the date
 * clamps to the end of a short month and springs back afterwards.
 *
 *   31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 May
 */
export function addMonths(
  date: Date,
  months: number,
  anchorDay?: number,
): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = anchorDay ?? date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = new Date(date);
  d.setUTCFullYear(year, month, Math.min(day, daysInMonth));
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Midnight UTC on the same calendar day.
 *
 * Transaction dates are stored two ways: an imported row keeps the time printed
 * on the statement, a hand-entered one sits at midnight. Comparing those as
 * instants makes a payment entered by hand on the due date look like it
 * happened *before* a due date carrying a time — so a reminder whose due date
 * came from an imported transaction (13:28:03, say) was never settled by
 * entering that month's payment yourself. Reminder matching is a question about
 * days, so it asks about days.
 */
export function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
