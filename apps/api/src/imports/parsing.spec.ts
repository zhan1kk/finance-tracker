import { parseAmount, parseDate } from './parsing';

describe('parseAmount', () => {
  it('parses signed decimals with a dot separator', () => {
    expect(parseAmount('-12.50')).toBe(-1250);
    expect(parseAmount('12.50')).toBe(1250);
    expect(parseAmount('1,234.56')).toBe(123456);
  });

  it('parses a comma decimal separator with dot thousands', () => {
    expect(parseAmount('12,50', ',')).toBe(1250);
    expect(parseAmount('1.234,56', ',')).toBe(123456);
  });

  it('treats accounting parentheses as negative', () => {
    expect(parseAmount('(5.00)')).toBe(-500);
  });

  it('ignores currency symbols and spaces', () => {
    expect(parseAmount('€ 3.00')).toBe(300);
    expect(parseAmount('$1,000.00')).toBe(100000);
  });

  it('returns null for non-numbers', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO date-only anchored to UTC midnight', () => {
    expect(parseDate('2026-07-01', 'ISO')?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('parses European and US formats', () => {
    expect(parseDate('01.07.2026', 'DD.MM.YYYY')?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseDate('07/01/2026', 'MM/DD/YYYY')?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseDate('01/07/2026', 'DD/MM/YYYY')?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('rejects invalid or overflowing dates', () => {
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('nope', 'ISO')).toBeNull();
    expect(parseDate('2026-07', 'DD.MM.YYYY')).toBeNull();
  });
});
