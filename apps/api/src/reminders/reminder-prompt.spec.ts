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

  it('matches money-owed hints between friends', () => {
    for (const s of [
      "125 is Shar's share, need to ask her",
      'Pasta (shared w Amaani)',
      "Cake for Chloe's bday, got back from all but Esther",
      'Shar paid for the tea',
      "paid for drinks, they'll pay me back",
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
  it('keeps valid rows, normalizes fields, and reads N/M installments', () => {
    expect(
      coerceExtractedReminders([
        {
          index: 1,
          label: '  ImmoScout ',
          dueDate: '2026-07-09',
          amount: 34.99,
          cadence: 'Monthly',
          installmentsTotal: 3,
          installmentsPaid: 1,
          note: '',
        },
        { index: 2, label: 'TV Tax', amount: '55', cadence: 'quarterly' },
      ]),
    ).toEqual([
      {
        index: 1,
        label: 'ImmoScout',
        dueDate: '2026-07-09',
        amount: 34.99,
        cadence: 'monthly',
        installmentsTotal: 3,
        installmentsPaid: 1,
        note: null,
      },
      {
        index: 2,
        label: 'TV Tax',
        dueDate: null,
        amount: 55,
        cadence: 'quarterly',
        installmentsTotal: null,
        installmentsPaid: null,
        note: null,
      },
    ]);
  });

  it('ignores an installment total below 2 and clamps paid to it', () => {
    const [a, b] = coerceExtractedReminders([
      { index: 1, label: 'x', installmentsTotal: 1, installmentsPaid: 1 },
      { index: 2, label: 'y', installmentsTotal: 3, installmentsPaid: 9 },
    ]);
    expect(a).toMatchObject({ installmentsTotal: null, installmentsPaid: null });
    expect(b).toMatchObject({ installmentsTotal: 3, installmentsPaid: 3 });
  });

  it('drops rows without an index or label, and bad dates', () => {
    expect(
      coerceExtractedReminders([
        { index: 1, label: '' },
        { label: 'no index' },
        { index: 3, label: 'bad date', dueDate: 'soon' },
      ]),
    ).toEqual([
      {
        index: 3,
        label: 'bad date',
        dueDate: null,
        amount: null,
        cadence: null,
        installmentsTotal: null,
        installmentsPaid: null,
        note: null,
      },
    ]);
    expect(coerceExtractedReminders(null)).toEqual([]);
  });
});
