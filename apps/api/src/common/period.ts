/**
 * Financial months.
 *
 * With `monthStartDay = 1` these are plain calendar months. With 29 (a pay cycle
 * that starts when salary lands) a month runs 29 May–28 Jun and is **labelled by
 * the month it ends in** — "June" — because that is the month the money covers.
 *
 * The whole thing is one shift: subtract `monthStartDay - 1` days from a date and
 * take its calendar month. That is exact in SQL and in JS, needs no per-month
 * special cases, and cannot produce gaps or overlaps. February falls out of it
 * for free: after 29 Jan–28 Feb the next period is simply 1–28 Mar, because no
 * 29 February exists to start one.
 */

export const CALENDAR_MONTH_START = 1;

/** Days to shift a date back by before truncating to a month. */
export function periodOffsetDays(monthStartDay: number): number {
  return clampStartDay(monthStartDay) - 1;
}

/** Periods are named after the month they end in, unless they are calendar months. */
export function periodLabelShiftMonths(monthStartDay: number): number {
  return clampStartDay(monthStartDay) > CALENDAR_MONTH_START ? 1 : 0;
}

/**
 * Any day of the month is workable: the shift keeps periods contiguous even when
 * a month is too short to contain the start day (a 29th start simply yields
 * 1–28 March after February).
 */
export function clampStartDay(monthStartDay: number): number {
  if (!Number.isInteger(monthStartDay)) return CALENDAR_MONTH_START;
  return Math.min(Math.max(monthStartDay, 1), 31);
}

/**
 * Inclusive-start, exclusive-end bounds of the period labelled `YYYY-MM`.
 * For start day 29, "2026-06" is [29 May 2026, 29 Jun 2026).
 */
export function periodBounds(
  label: string,
  monthStartDay: number,
): { start: Date; end: Date } {
  const [year, month] = label.split('-').map(Number);
  const offset = periodOffsetDays(monthStartDay);
  const shift = periodLabelShiftMonths(monthStartDay);
  // Undo the label shift to get the underlying calendar month, then re-apply
  // the day offset to land on the real boundaries.
  const base = Date.UTC(year, month - 1 - shift, 1);
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() + offset);
  const end = new Date(Date.UTC(year, month - shift, 1));
  end.setUTCDate(end.getUTCDate() + offset);
  return { start, end };
}

/** The label of the period containing `date`. */
export function periodLabel(date: Date, monthStartDay: number): string {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - periodOffsetDays(monthStartDay));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + periodLabelShiftMonths(monthStartDay);
  // Month may overflow to 12; Date.UTC normalises it into the next year.
  const normalised = new Date(Date.UTC(year, month, 1));
  return `${normalised.getUTCFullYear()}-${String(normalised.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `count` period labels ending with the one containing `date`, oldest first. */
export function recentPeriodLabels(
  date: Date,
  monthStartDay: number,
  count: number,
): string[] {
  const current = periodLabel(date, monthStartDay);
  const [year, month] = current.split('-').map(Number);
  const labels: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const at = new Date(Date.UTC(year, month - 1 - back, 1));
    labels.push(
      `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  return labels;
}
