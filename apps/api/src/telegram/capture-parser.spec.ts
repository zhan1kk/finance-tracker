import { matchSubcategory, parseCapture } from './capture-parser';

describe('parseCapture', () => {
  it('parses amount, category and description', () => {
    expect(parseCapture('12.50 groceries lunch stuff')).toEqual({
      type: 'EXPENSE',
      amountCents: 1250,
      categoryQuery: 'groceries',
      description: 'lunch stuff',
    });
  });

  it('parses without a description and with a comma decimal', () => {
    expect(parseCapture('7,99 transport')).toEqual({
      type: 'EXPENSE',
      amountCents: 799,
      categoryQuery: 'transport',
      description: undefined,
    });
  });

  it('treats a + prefix as income', () => {
    expect(parseCapture('+2000 salary july')).toMatchObject({
      type: 'INCOME',
      amountCents: 200_000,
      categoryQuery: 'salary',
    });
  });

  it('rejects garbage, missing category, zero and >2 decimals', () => {
    expect(parseCapture('lunch 12.50')).toBeNull();
    expect(parseCapture('12.50')).toBeNull();
    expect(parseCapture('0 groceries')).toBeNull();
    expect(parseCapture('12.505 groceries')).toBeNull();
    expect(parseCapture('-5 groceries')).toBeNull();
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
