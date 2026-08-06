import { detectRecurringBills, type BillTxn } from './recurring-detect';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const txn = (over: Partial<BillTxn>): BillTxn => ({
  id: 'x',
  subcategoryId: 's',
  name: 'Netflix',
  date: day('2026-01-01'),
  amount: 999,
  currency: 'EUR',
  ...over,
});

describe('detectRecurringBills', () => {
  const now = day('2026-05-01');

  it('flags a monthly bill with the latest amount and a future next date', () => {
    const res = detectRecurringBills(
      [
        txn({ id: 'a', date: day('2026-02-10') }),
        txn({ id: 'b', date: day('2026-03-11') }),
        txn({ id: 'c', date: day('2026-04-09'), amount: 1099 }),
      ],
      now,
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      cadence: 'monthly',
      amountCents: 1099,
      sourceTransactionId: 'c',
      label: 'Netflix',
    });
    expect(res[0].nextDate.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('flags a quarterly bill', () => {
    const res = detectRecurringBills(
      [
        txn({ id: 'a', subcategoryId: 'q', name: 'Insurance', date: day('2025-12-01') }),
        txn({ id: 'b', subcategoryId: 'q', name: 'Insurance', date: day('2026-03-02') }),
      ],
      now,
    );
    expect(res).toHaveLength(1);
    expect(res[0].cadence).toBe('quarterly');
  });

  it('ignores a single non-obvious charge and irregular spacing', () => {
    expect(detectRecurringBills([txn({ id: 'a' })], now)).toEqual([]);
    expect(
      detectRecurringBills(
        [
          txn({ id: 'a', date: day('2026-01-01') }),
          txn({ id: 'b', date: day('2026-01-08') }), // a week apart, not monthly
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('flags obvious bills (Rent) from a single occurrence', () => {
    const res = detectRecurringBills(
      [
        txn({
          id: 'a',
          subcategoryId: 'r',
          name: 'Rent',
          date: day('2026-04-01'),
          amount: 80_000,
        }),
      ],
      now,
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ cadence: 'monthly', label: 'Rent' });
  });
});
