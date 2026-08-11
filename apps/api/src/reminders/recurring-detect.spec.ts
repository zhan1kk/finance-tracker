import { detectRecurringBills, type BillTxn } from './recurring-detect';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const txn = (over: Partial<BillTxn>): BillTxn => ({
  id: 'x',
  subcategoryId: 's',
  name: 'Netflix',
  date: day('2026-01-01'),
  amount: 999,
  currency: 'EUR',
  description: null,
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

  it('handles a lumped subcategory (many charges a month) as monthly, with the month total', () => {
    const res = detectRecurringBills(
      [
        // March: two streaming services on different days.
        txn({ id: 'n1', subcategoryId: 'subs', name: 'Subscriptions', date: day('2026-03-05'), amount: 999 }),
        txn({ id: 's1', subcategoryId: 'subs', name: 'Subscriptions', date: day('2026-03-12'), amount: 1_099 }),
        // April: the same two.
        txn({ id: 'n2', subcategoryId: 'subs', name: 'Subscriptions', date: day('2026-04-05'), amount: 999 }),
        txn({ id: 's2', subcategoryId: 'subs', name: 'Subscriptions', date: day('2026-04-12'), amount: 1_099 }),
      ],
      now,
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      cadence: 'monthly',
      amountCents: 999 + 1_099, // the most recent complete month's total
      label: 'Subscriptions',
      sourceTransactionId: 's2',
    });
  });

  it('uses the most recent complete month, ignoring a partial current one', () => {
    const asOf = day('2026-05-20'); // mid-May: May is still in progress
    const res = detectRecurringBills(
      [
        // Full months: two streaming services each.
        txn({ id: 'm1', subcategoryId: 'subs', name: 'Streaming', date: day('2026-03-05'), amount: 999 }),
        txn({ id: 'm2', subcategoryId: 'subs', name: 'Streaming', date: day('2026-03-12'), amount: 1_099 }),
        txn({ id: 'a1', subcategoryId: 'subs', name: 'Streaming', date: day('2026-04-05'), amount: 999 }),
        txn({ id: 'a2', subcategoryId: 'subs', name: 'Streaming', date: day('2026-04-12'), amount: 1_099 }),
        // Only one has posted so far this (current) month — don't let it
        // understate the reminder amount.
        txn({ id: 'p1', subcategoryId: 'subs', name: 'Streaming', date: day('2026-05-05'), amount: 999 }),
      ],
      asOf,
    );
    expect(res).toHaveLength(1);
    expect(res[0].amountCents).toBe(999 + 1_099); // April's full total, not May's 999
  });

  it('marks a recurring bill as a limited plan when the description says "N/M"', () => {
    const res = detectRecurringBills(
      [
        txn({ id: 'a', name: 'Course', date: day('2026-03-10'), description: 'Business course 2/6' }),
        // The anchor (latest) carries the current progress.
        txn({ id: 'b', name: 'Course', date: day('2026-04-10'), description: 'Business course 3/6' }),
      ],
      now,
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      cadence: 'monthly',
      installmentsTotal: 6,
      installmentsPaid: 3,
      sourceTransactionId: 'b',
    });
  });

  it('leaves an open-ended recurring bill without installments', () => {
    const res = detectRecurringBills(
      [
        txn({ id: 'a', date: day('2026-03-10') }),
        txn({ id: 'b', date: day('2026-04-10') }),
      ],
      now,
    );
    expect(res[0]).toMatchObject({
      installmentsTotal: null,
      installmentsPaid: null,
    });
  });

  it('ignores a single charge even for a bill that looks obvious', () => {
    // No hardcoded bill names — a lone "Rent" charge has no pattern yet.
    const res = detectRecurringBills(
      [txn({ id: 'a', subcategoryId: 'r', name: 'Rent', date: day('2026-04-01'), amount: 80_000 })],
      now,
    );
    expect(res).toEqual([]);
  });
});
