import {
  matchSubcategory,
  parseAmountOnly,
  parseCapture,
  parseCaptureDate,
} from './capture-parser';

describe('parseCapture (dash format)', () => {
  it('parses amount and a multi-word category', () => {
    expect(parseCapture('40 - dining out')).toEqual({
      type: 'EXPENSE',
      amountCents: 4000,
      categoryQuery: 'dining out',
      description: undefined,
      date: undefined,
    });
  });

  it('parses an optional description and a comma decimal', () => {
    expect(parseCapture('12,50 - groceries - lunch with friends')).toEqual({
      type: 'EXPENSE',
      amountCents: 1250,
      categoryQuery: 'groceries',
      description: 'lunch with friends',
      date: undefined,
    });
  });

  it('treats a + prefix as income', () => {
    expect(parseCapture('+2000 - salary - july')).toMatchObject({
      type: 'INCOME',
      amountCents: 200_000,
      categoryQuery: 'salary',
      description: 'july',
    });
  });

  it('takes a trailing date segment (DD.MM, DD.MM.YYYY, ISO)', () => {
    const year = new Date().getUTCFullYear();
    expect(parseCapture('40 - dining out - lunch - 09.07')).toMatchObject({
      description: 'lunch',
      date: `${year}-07-09`,
    });
    expect(parseCapture('40 - rent - 01.07.2026')).toMatchObject({
      description: undefined,
      date: '2026-07-01',
    });
    expect(parseCapture('40 - rent - deposit - 2026-07-03')).toMatchObject({
      description: 'deposit',
      date: '2026-07-03',
    });
  });

  it('keeps an invalid date-like segment as description', () => {
    expect(parseCapture('40 - rent - 31.02')).toMatchObject({
      description: '31.02',
      date: undefined,
    });
  });

  it('keeps inner dashes of a description together', () => {
    expect(
      parseCapture('9 - transport - check-in shuttle - airport'),
    ).toMatchObject({
      description: 'check-in shuttle - airport',
    });
  });

  it('rejects garbage, missing category, zero and >2 decimals', () => {
    expect(parseCapture('lunch - 12.50')).toBeNull();
    expect(parseCapture('12.50')).toBeNull();
    expect(parseCapture('what is my balance?')).toBeNull();
    expect(parseCapture('0 - groceries')).toBeNull();
    expect(parseCapture('12.505 - groceries')).toBeNull();
    expect(parseCapture('-5 - groceries')).toBeNull();
  });
});

describe('parseCaptureDate', () => {
  it('parses supported formats and rejects invalid dates', () => {
    expect(parseCaptureDate('2026-07-09')).toBe('2026-07-09');
    expect(parseCaptureDate('09.07.2026')).toBe('2026-07-09');
    expect(parseCaptureDate('31.02.2026')).toBeNull();
    expect(parseCaptureDate('yesterday')).toBeNull();
  });
});

describe('matchSubcategory', () => {
  const subs = [
    { name: 'Groceries' },
    { name: 'Gifts' },
    { name: 'Going out' },
    { name: 'Rent' },
  ];

  it('matches exact names case-insensitively', () => {
    expect(matchSubcategory(subs, 'RENT')).toEqual({
      match: { name: 'Rent' },
    });
  });

  it('matches a unique prefix', () => {
    expect(matchSubcategory(subs, 'groc')).toEqual({
      match: { name: 'Groceries' },
    });
  });

  it('reports ambiguous prefixes instead of guessing', () => {
    expect(matchSubcategory(subs, 'g')).toEqual({
      ambiguous: ['Groceries', 'Gifts', 'Going out'],
    });
  });

  it('falls back to substring match', () => {
    expect(matchSubcategory(subs, 'out')).toEqual({
      match: { name: 'Going out' },
    });
  });

  it('returns empty ambiguous list when nothing matches', () => {
    expect(matchSubcategory(subs, 'zzz')).toEqual({ ambiguous: [] });
  });
});

describe('parseAmountOnly', () => {
  it('treats a bare number as an expense to be picked from buttons', () => {
    expect(parseAmountOnly('40')).toEqual({
      type: 'EXPENSE',
      amountCents: 4000,
    });
    expect(parseAmountOnly(' 12.50 ')).toEqual({
      type: 'EXPENSE',
      amountCents: 1250,
    });
    expect(parseAmountOnly('12,50')).toEqual({
      type: 'EXPENSE',
      amountCents: 1250,
    });
  });

  it('reads a leading + as income', () => {
    expect(parseAmountOnly('+2000')).toEqual({
      type: 'INCOME',
      amountCents: 200_000,
    });
  });

  it('ignores anything richer, leaving it to the one-shot format', () => {
    // These must fall through to parseCapture, not open the picker.
    expect(parseAmountOnly('40 - groceries')).toBeNull();
    expect(parseAmountOnly('40 groceries')).toBeNull();
    expect(parseAmountOnly('/account')).toBeNull();
    expect(parseAmountOnly('hello')).toBeNull();
    expect(parseAmountOnly('')).toBeNull();
  });

  it('rejects zero and over-precise amounts', () => {
    expect(parseAmountOnly('0')).toBeNull();
    expect(parseAmountOnly('0.00')).toBeNull();
    expect(parseAmountOnly('1.234')).toBeNull();
  });
});
