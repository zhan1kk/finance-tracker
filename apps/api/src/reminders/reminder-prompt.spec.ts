import {
  coerceExtractedReminders,
  looksLikeReminder,
} from './reminder-prompt';

describe('looksLikeReminder', () => {
  it('matches future-payment hints', () => {
    for (const s of [
      '1/3 payment for the sofa',
      'TV Tax next payment by 15.09.2026 - 55',
      'ImmoScout (monthly)',
      'next payment in Sep',
      'Rate 2 von 3',
    ]) {
      expect(looksLikeReminder(s)).toBe(true);
    }
  });

  it('ignores ordinary descriptions and null', () => {
    expect(looksLikeReminder('Albert Heijn groceries')).toBe(false);
    expect(looksLikeReminder('Spotify')).toBe(false);
    expect(looksLikeReminder(null)).toBe(false);
  });
});

describe('coerceExtractedReminders', () => {
  it('keeps valid rows and normalizes fields', () => {
    expect(
      coerceExtractedReminders([
        {
          index: 1,
          label: '  TV Tax ',
          dueDate: '2026-09-15',
          amount: 55,
          cadence: 'One-Off',
          note: '',
        },
        { index: 2, label: 'ImmoScout', amount: '850', cadence: 'monthly' },
      ]),
    ).toEqual([
      {
        index: 1,
        label: 'TV Tax',
        dueDate: '2026-09-15',
        amount: 55,
        cadence: 'one-off',
        note: null,
      },
      {
        index: 2,
        label: 'ImmoScout',
        dueDate: null,
        amount: 850,
        cadence: 'monthly',
        note: null,
      },
    ]);
  });

  it('drops rows without an index or label, and bad dates', () => {
    expect(
      coerceExtractedReminders([
        { index: 1, label: '' },
        { label: 'no index' },
        { index: 3, label: 'bad date', dueDate: 'soon' },
      ]),
    ).toEqual([
      { index: 3, label: 'bad date', dueDate: null, amount: null, cadence: null, note: null },
    ]);
    expect(coerceExtractedReminders(null)).toEqual([]);
  });
});
