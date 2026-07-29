import {
  periodBounds,
  periodLabel,
  recentPeriodLabels,
  clampStartDay,
} from './period';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('periodLabel with a 29th start', () => {
  const START = 29;

  it('labels a period by the month it ends in', () => {
    // 29 May–28 Jun is "June": the money received on the 29th funds June.
    expect(periodLabel(day('2026-05-29'), START)).toBe('2026-06');
    expect(periodLabel(day('2026-06-10'), START)).toBe('2026-06');
    expect(periodLabel(day('2026-06-28'), START)).toBe('2026-06');
  });

  it('rolls to the next period on the start day', () => {
    expect(periodLabel(day('2026-06-28'), START)).toBe('2026-06');
    expect(periodLabel(day('2026-06-29'), START)).toBe('2026-07');
  });

  it('puts a date before the first start day in the previous period', () => {
    expect(periodLabel(day('2026-05-28'), START)).toBe('2026-05');
  });

  it('crosses the year boundary', () => {
    expect(periodLabel(day('2026-12-29'), START)).toBe('2027-01');
    expect(periodLabel(day('2027-01-28'), START)).toBe('2027-01');
  });

  it('handles February, which has no 29th to start a period', () => {
    // 29 Jan–28 Feb is February; March then starts on the 1st.
    expect(periodLabel(day('2026-01-29'), START)).toBe('2026-02');
    expect(periodLabel(day('2026-02-28'), START)).toBe('2026-02');
    expect(periodLabel(day('2026-03-01'), START)).toBe('2026-03');
    expect(periodLabel(day('2026-03-28'), START)).toBe('2026-03');
    expect(periodLabel(day('2026-03-29'), START)).toBe('2026-04');
  });

  it('is plain calendar months when the start day is 1', () => {
    expect(periodLabel(day('2026-06-01'), 1)).toBe('2026-06');
    expect(periodLabel(day('2026-06-30'), 1)).toBe('2026-06');
    expect(periodLabel(day('2026-07-01'), 1)).toBe('2026-07');
  });
});

describe('periodBounds', () => {
  it('round-trips with periodLabel at both edges', () => {
    const { start, end } = periodBounds('2026-06', 29);
    expect(iso(start)).toBe('2026-05-29');
    // End is exclusive: the last day inside is 28 June.
    expect(iso(end)).toBe('2026-06-29');
    expect(periodLabel(start, 29)).toBe('2026-06');
    expect(periodLabel(day('2026-06-28'), 29)).toBe('2026-06');
    expect(periodLabel(end, 29)).toBe('2026-07');
  });

  it('gives calendar bounds for a start day of 1', () => {
    const { start, end } = periodBounds('2026-06', 1);
    expect(iso(start)).toBe('2026-06-01');
    expect(iso(end)).toBe('2026-07-01');
  });

  it('leaves no gap or overlap between consecutive periods', () => {
    for (const [a, b] of [
      ['2026-01', '2026-02'],
      ['2026-02', '2026-03'],
      ['2026-12', '2027-01'],
    ]) {
      expect(iso(periodBounds(a, 29).end)).toBe(iso(periodBounds(b, 29).start));
    }
  });

  it('produces the short 1–28 March period after February', () => {
    const march = periodBounds('2026-03', 29);
    expect(iso(march.start)).toBe('2026-03-01');
    expect(iso(march.end)).toBe('2026-03-29');
  });
});

describe('recentPeriodLabels', () => {
  it('returns consecutive labels ending with the current period', () => {
    expect(recentPeriodLabels(day('2026-07-22'), 29, 3)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });
});

describe('clampStartDay', () => {
  it('accepts any real day of the month', () => {
    expect(clampStartDay(29)).toBe(29);
    expect(clampStartDay(31)).toBe(31);
    expect(clampStartDay(15)).toBe(15);
  });

  it('falls back to calendar months for nonsense input', () => {
    expect(clampStartDay(0)).toBe(1);
    expect(clampStartDay(99)).toBe(31);
    expect(clampStartDay(1.5)).toBe(1);
  });
});
