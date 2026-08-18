/** Whole days from `from` to `to`, ignoring time of day. */
export function daysUntil(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whether a payment due in `days` days should be nudged today.
 *
 * Counting down from the lead time in steps of the interval: lead 10 / every 3
 * gives 10, 7, 4, 1 — the pattern the user asked for. The due day itself always
 * nudges, because "it's due today" is the one worth saying out loud even when
 * the arithmetic skips it.
 *
 * Overdue payments are left alone on purpose: the app already shows them as
 * overdue, and a bill you have not paid would otherwise nag every single day.
 */
export function shouldPing(
  days: number,
  leadDays: number,
  intervalDays: number,
): boolean {
  if (days < 0 || days > leadDays) return false;
  if (days === 0) return true;
  const step = Math.max(1, Math.floor(intervalDays));
  return (leadDays - days) % step === 0;
}
