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
      "50 is Alex's share, need to ask them",
      'Pasta (shared w Sam)',
      'Cake for the party, got back from everyone but Jordan',
      'Alex paid for the tea',
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
        kind: 'payment',
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
        kind: 'payment',
        dueDate: null,
        amount: 55,
        cadence: 'quarterly',
        installmentsTotal: null,
        installmentsPaid: null,
        note: null,
      },
    ]);
  });

  it('sets kind from the model, or infers it from the label prefix', () => {
    const rows = coerceExtractedReminders([
      { index: 1, label: 'Ask Alex for their share', kind: 'ask' },
      { index: 2, label: 'Pay Sam back' }, // no kind → inferred from "Pay "
      { index: 3, label: 'Ask Jordan' }, // no kind → inferred from "Ask"
      { index: 4, label: 'Netflix', kind: 'nonsense' }, // bad kind → default
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['ask', 'pay', 'ask', 'payment']);
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
        kind: 'payment',
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
