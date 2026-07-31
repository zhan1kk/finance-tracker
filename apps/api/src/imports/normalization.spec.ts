import { dedupeHash, normalizeMerchant } from './normalization';

describe('normalizeMerchant', () => {
  it('lowercases and keeps the card-ref after * as a trailing token', () => {
    expect(normalizeMerchant('AMZN Mktp DE*1J4X9AB')).toBe(
      'amzn mktp de 1j4x9ab',
    );
  });

  it('keeps a *card-ref so top-ups from different cards stay distinct', () => {
    // The card ref is the only thing telling these apart (one funds from Vivid,
    // the other from Advanzia), so it must survive normalization to be ruleable.
    expect(normalizeMerchant('Apple Pay top-up by *4397')).toBe(
      'apple pay top up by 4397',
    );
    expect(normalizeMerchant('Apple Pay top-up by *4808')).toBe(
      'apple pay top up by 4808',
    );
    expect(normalizeMerchant('Apple Pay top-up by *4397')).not.toBe(
      normalizeMerchant('Apple Pay top-up by *4808'),
    );
  });

  it('strips processing noise and long digit runs', () => {
    expect(normalizeMerchant('POS 1234 SPOTIFY AB12')).toBe('spotify ab12');
    expect(normalizeMerchant('CARD Albert Heijn 5678')).toBe('albert heijn');
  });

  it('keeps direction words (transfer/payment) that distinguish destinations', () => {
    // Stripping these collapsed "Transfer to X" and "to X" — two different
    // destinations — into one un-distinguishable rule, so they are preserved.
    expect(normalizeMerchant('Transfer to ZHANNUR BOLAT')).toBe(
      'transfer to zhannur bolat',
    );
    expect(normalizeMerchant('to Zhannur Bolat')).toBe('to zhannur bolat');
    expect(normalizeMerchant('Payment from KAMILA JUSUPOVA')).toBe(
      'payment from kamila jusupova',
    );
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeMerchant('  Bol.com   B.V. ')).toBe('bol com');
  });

  it('keeps non-Latin (Cyrillic/Kazakh) counterparty names distinct', () => {
    // Stripping non-ASCII collapsed every named transfer to "transfers" — false
    // duplicates and one rule matching everyone. Kaspi statements name people in
    // Cyrillic, so those letters must survive normalization.
    expect(normalizeMerchant('Transfers Темирлан Н.')).toBe(
      'transfers темирлан',
    );
    expect(normalizeMerchant('Transfers Диас Д.')).toBe('transfers диас');
    expect(normalizeMerchant('Transfers Темирлан Н.')).not.toBe(
      normalizeMerchant('Transfers Диас Д.'),
    );
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
