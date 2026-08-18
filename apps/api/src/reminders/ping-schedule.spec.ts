import { daysUntil, shouldPing } from './ping-schedule';

describe('daysUntil', () => {
  // Local time on purpose: a payment is "due tomorrow" by the calendar the user
  // lives in, and the server runs in their timezone (TZ is set in compose).
  it('counts whole days, ignoring the clock', () => {
    const lateOnThe18th = new Date(2026, 7, 18, 23, 30);
    const earlyOnThe19th = new Date(2026, 7, 19, 0, 10);
    expect(daysUntil(lateOnThe18th, earlyOnThe19th)).toBe(1);
    expect(daysUntil(earlyOnThe19th, lateOnThe18th)).toBe(-1);
    expect(daysUntil(lateOnThe18th, new Date(2026, 7, 18, 6, 0))).toBe(0);
  });

  it('counts across a month boundary', () => {
    expect(daysUntil(new Date(2026, 7, 30), new Date(2026, 8, 1))).toBe(2);
  });
});

describe('shouldPing', () => {
  it('nudges on the pattern the user asked for (lead 10, every 3)', () => {
    const pinged = [];
    for (let d = 14; d >= 0; d--) if (shouldPing(d, 10, 3)) pinged.push(d);
    expect(pinged).toEqual([10, 7, 4, 1, 0]);
  });

  it('stays quiet before the lead time and after the due date', () => {
    expect(shouldPing(11, 10, 3)).toBe(false);
    // Overdue is deliberately silent — the app shows it, and a daily nag on an
    // unpaid bill is worse than none.
    expect(shouldPing(-1, 10, 3)).toBe(false);
    expect(shouldPing(-30, 10, 3)).toBe(false);
  });

  it('handles a daily cadence and a degenerate interval', () => {
    for (let d = 5; d >= 0; d--) expect(shouldPing(d, 5, 1)).toBe(true);
    expect(shouldPing(3, 10, 0)).toBe(true); // interval floors at 1, never divides by zero
  });
});
