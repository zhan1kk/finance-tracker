import {
  coerceExtractedReminders,
  extractInstallment,
  installmentLabel,
  looksLikeIou,
} from './reminder-prompt';

describe('extractInstallment', () => {
  it('reads an N/M marker as paid/total', () => {
    expect(extractInstallment('1/3 payment for the sofa')).toEqual({ paid: 1, total: 3 });
    expect(extractInstallment('Bfs · 7/12')).toEqual({ paid: 7, total: 12 });
    expect(extractInstallment('TV plan 3/42')).toEqual({ paid: 3, total: 42 });
    expect(extractInstallment('3 / 3 final')).toEqual({ paid: 3, total: 3 });
  });

  it('rejects dates, ratios, and non-installment fractions', () => {
    expect(extractInstallment('due by 15/09')).toBeNull(); // N>M → a date
    expect(extractInstallment('open 24/7')).toBeNull(); // N>M → a ratio
    expect(extractInstallment('renew 1/2026')).toBeNull(); // total too large
    expect(extractInstallment('split 50/50 with Sam')).toBeNull(); // equal split, not a plan
    expect(extractInstallment('Albert Heijn groceries')).toBeNull();
    expect(extractInstallment(null)).toBeNull();
  });
});

describe('installmentLabel', () => {
  it('prefers the subcategory name', () => {
    expect(installmentLabel('Bfs · 7/12', 'Dentist Installment Payments')).toBe(
      'Dentist Installment Payments',
    );
  });

  it('falls back to the description with the marker and separators stripped', () => {
    expect(installmentLabel('Bfs · 7/12', null)).toBe('Bfs');
    expect(installmentLabel('7/12', '')).toBe('Installment payment');
  });
});

describe('looksLikeIou', () => {
  it('matches money-owed hints between friends', () => {
    for (const s of [
      "50 is Alex's share, need to ask them",
      'Pasta (shared w Sam)',
      'Cake for the party, got back from everyone but Jordan',
      'Alex paid for the tea',
      "paid for drinks, they'll pay me back",
    ]) {
      expect(looksLikeIou(s)).toBe(true);
    }
  });

  it('ignores bills, subscriptions, and null', () => {
    expect(looksLikeIou('ImmoScout (monthly)')).toBe(false);
    expect(looksLikeIou('Spotify')).toBe(false);
    expect(looksLikeIou(null)).toBe(false);
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
