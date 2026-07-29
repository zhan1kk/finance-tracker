/**
 * Financial months, mirroring the API's `common/period.ts`.
 *
 * With `monthStartDay = 1` these are calendar months. With 29 a month runs
 * 29 May–28 Jun and is labelled by the month it ends in ("June"), because that
 * is the month the money covers.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const label = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;

function offsetDays(monthStartDay: number): number {
  return clampStartDay(monthStartDay) - 1;
}

function labelShift(monthStartDay: number): number {
  return clampStartDay(monthStartDay) > 1 ? 1 : 0;
}

export function clampStartDay(monthStartDay: number): number {
  if (!Number.isInteger(monthStartDay)) return 1;
  return Math.min(Math.max(monthStartDay, 1), 31);
}

/** Inclusive start and **inclusive** end dates (ISO) of a labelled period. */
export function periodRange(
  periodLabel: string,
  monthStartDay: number,
): { from: string; to: string } {
  const [year, month] = periodLabel.split("-").map(Number);
  const shift = labelShift(monthStartDay);
  const offset = offsetDays(monthStartDay);

  const start = new Date(Date.UTC(year, month - 1 - shift, 1));
  start.setUTCDate(start.getUTCDate() + offset);
  const end = new Date(Date.UTC(year, month - shift, 1));
  end.setUTCDate(end.getUTCDate() + offset - 1); // inclusive last day

  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** The label of the period containing `date`. */
export function periodOf(date: Date, monthStartDay: number): string {
  const shifted = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  shifted.setUTCDate(shifted.getUTCDate() - offsetDays(monthStartDay));
  return label(
    new Date(
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth() + labelShift(monthStartDay),
        1,
      ),
    ),
  );
}

/** Steps a label forwards or backwards by whole periods. */
export function shiftPeriod(periodLabel: string, by: number): string {
  const [year, month] = periodLabel.split("-").map(Number);
  return label(new Date(Date.UTC(year, month - 1 + by, 1)));
}

/** "June 2026", or "29 May – 28 Jun" when months do not start on the 1st. */
export function formatPeriod(
  periodLabel: string,
  monthStartDay: number,
): string {
  const [year, month] = periodLabel.split("-").map(Number);
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
  if (clampStartDay(monthStartDay) === 1) return name;

  const { from, to } = periodRange(periodLabel, monthStartDay);
  const short = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return `${name} · ${short(from)} – ${short(to)}`;
}
