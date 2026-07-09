import { nextOccurrence, occurrencesPerYear } from './cadence';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('nextOccurrence', () => {
  it('advances by days and weeks', () => {
    expect(iso(nextOccurrence(new Date('2026-01-01'), 'DAILY', 1))).toBe(
      '2026-01-02',
    );
    expect(iso(nextOccurrence(new Date('2026-01-01'), 'WEEKLY', 2))).toBe(
      '2026-01-15',
    );
  });

  it('advances by months and years', () => {
    expect(iso(nextOccurrence(new Date('2026-01-15'), 'MONTHLY', 1))).toBe(
      '2026-02-15',
    );
    expect(iso(nextOccurrence(new Date('2026-03-15'), 'YEARLY', 1))).toBe(
      '2027-03-15',
    );
  });

  it('clamps a month-end anchor without drifting', () => {
    // A rule on the 31st: Feb clamps to the 28th, then returns to the 31st.
    const anchor = 31;
    const feb = nextOccurrence(new Date('2026-01-31'), 'MONTHLY', 1, anchor);
    expect(iso(feb)).toBe('2026-02-28');
    const mar = nextOccurrence(feb, 'MONTHLY', 1, anchor);
    expect(iso(mar)).toBe('2026-03-31');
  });

  it('clamps a Feb-29 yearly anchor on non-leap years', () => {
    expect(iso(nextOccurrence(new Date('2024-02-29'), 'YEARLY', 1, 29))).toBe(
      '2025-02-28',
    );
  });
});

describe('occurrencesPerYear', () => {
  it('estimates frequency from cadence and interval', () => {
    expect(occurrencesPerYear('MONTHLY', 1)).toBe(12);
    expect(occurrencesPerYear('WEEKLY', 2)).toBe(26);
    expect(occurrencesPerYear('YEARLY', 1)).toBe(1);
  });
});
