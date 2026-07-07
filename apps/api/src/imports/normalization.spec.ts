import { dedupeHash, normalizeMerchant } from './normalization';

describe('normalizeMerchant', () => {
  it('lowercases and drops the card-ref segment after *', () => {
    expect(normalizeMerchant('AMZN Mktp DE*1J4X9AB')).toBe('amzn mktp de');
  });

  it('strips noise tokens and long digit runs', () => {
    expect(normalizeMerchant('POS 1234 SPOTIFY AB12')).toBe('spotify ab12');
    expect(normalizeMerchant('CARD PAYMENT Albert Heijn 5678')).toBe(
      'albert heijn',
    );
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeMerchant('  Bol.com   B.V. ')).toBe('bol com');
  });
});

describe('dedupeHash', () => {
  const base = {
    accountId: 'acc-1',
    date: new Date('2026-07-01T00:00:00Z'),
    type: 'EXPENSE' as const,
    amount: 1250,
    normalizedDescription: 'albert heijn',
  };

  it('is stable for the same inputs', () => {
    expect(dedupeHash(base)).toBe(dedupeHash({ ...base }));
  });

  it('ignores the time of day (same calendar date collides)', () => {
    expect(
      dedupeHash({ ...base, date: new Date('2026-07-01T23:59:00Z') }),
    ).toBe(dedupeHash(base));
  });

  it('differs when any field differs', () => {
    expect(dedupeHash({ ...base, amount: 1251 })).not.toBe(dedupeHash(base));
    expect(dedupeHash({ ...base, type: 'INCOME' })).not.toBe(dedupeHash(base));
    expect(dedupeHash({ ...base, accountId: 'acc-2' })).not.toBe(
      dedupeHash(base),
    );
  });
});
