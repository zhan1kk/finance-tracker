import {
  applySpread,
  BASE_CURRENCY,
  MAX_SPREAD_PCT,
  pickRate,
  type RatePoint,
  toBase,
} from './fx';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('pickRate', () => {
  const rates: RatePoint[] = [
    { date: day('2026-03-01'), rate: 500 },
    { date: day('2026-05-01'), rate: 520 },
    { date: day('2026-07-01'), rate: 545 },
  ];

  it('falls back to the built-in default when the user has set no rates', () => {
    expect(pickRate([], day('2026-07-15'), 'KZT')).toBe(540);
  });

  it('uses the default for dates before the earliest user-set rate', () => {
    expect(pickRate(rates, day('2026-01-15'), 'KZT')).toBe(540);
  });

  it('picks the most recent rate on or before the date', () => {
    expect(pickRate(rates, day('2026-04-10'), 'KZT')).toBe(500);
    expect(pickRate(rates, day('2026-06-30'), 'KZT')).toBe(520);
    expect(pickRate(rates, day('2026-12-31'), 'KZT')).toBe(545);
  });

  it('applies a rate on its own effective date (inclusive boundary)', () => {
    expect(pickRate(rates, day('2026-05-01'), 'KZT')).toBe(520);
  });

  it('resolves a mid-day timestamp against the same calendar day', () => {
    expect(pickRate(rates, new Date('2026-07-01T21:30:00.000Z'), 'KZT')).toBe(
      545,
    );
  });

  it('always uses 1 for the base currency', () => {
    expect(pickRate(rates, day('2026-07-15'), BASE_CURRENCY)).toBe(1);
  });
});

describe('toBase', () => {
  it('passes base-currency amounts through untouched', () => {
    expect(toBase(12_345, BASE_CURRENCY, 1)).toBe(12_345);
  });

  it('converts foreign minor units to base minor units', () => {
    // 1200.00 KZT at 540 KZT/EUR = 2.22 EUR
    expect(toBase(120_000, 'KZT', 540)).toBe(222);
    // Exactly 540.00 KZT is 1.00 EUR
    expect(toBase(54_000, 'KZT', 540)).toBe(100);
  });

  it('rounds to the nearest cent rather than truncating', () => {
    expect(toBase(1000, 'KZT', 540)).toBe(2); // 1.85 -> 2
    expect(toBase(100, 'KZT', 540)).toBe(0); // 0.185 -> 0
  });

  it('tracks the rate: a weaker tenge yields fewer euros', () => {
    expect(toBase(540_000, 'KZT', 540)).toBe(1000);
    expect(toBase(540_000, 'KZT', 600)).toBe(900);
  });
});

describe('applySpread', () => {
  it('lowers the buy rate by the fee (1 EUR buys fewer foreign units)', () => {
    expect(applySpread(540, 2)).toBeCloseTo(529.2, 5);
    // Fewer KZT per EUR -> each KZT is worth slightly more when converting.
    expect(toBase(540_000, 'KZT', applySpread(540, 2))).toBeGreaterThan(1000);
  });

  it('is a no-op at 0%', () => {
    expect(applySpread(540, 0)).toBe(540);
  });

  it('clamps out-of-range fees to the allowed band', () => {
    expect(applySpread(540, -5)).toBe(540); // clamped to 0
    expect(applySpread(540, 50)).toBeCloseTo(
      540 * (1 - MAX_SPREAD_PCT / 100),
      5,
    );
  });
});
