import { planDeletion, planSettlement } from './settle';

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe('planSettlement', () => {
  const installment = (paid: number, total = 12) => ({
    dueDate: new Date('2026-08-24T00:00:00Z'),
    cadence: 'monthly',
    installmentsTotal: total,
    installmentsPaid: paid,
  });

  // The reported bug: pressing ✓ on a Telegram nudge for an installment plan
  // dismissed the whole plan instead of booking one payment.
  it('books one payment and moves to the next month, staying open', () => {
    const s = planSettlement(installment(3));
    expect(s.kind).toBe('installment');
    if (s.kind !== 'installment') throw new Error('unreachable');
    expect(s.paid).toBe(4);
    expect(s.data.done).toBe(false);
    expect(iso(s.data.dueDate)).toBe('2026-09-24');
    expect(iso(s.nextDue)).toBe('2026-09-24');
  });

  it('completes the plan on the final payment, and only then', () => {
    const last = planSettlement(installment(11));
    if (last.kind !== 'installment') throw new Error('unreachable');
    expect(last.paid).toBe(12);
    expect(last.finished).toBe(true);
    expect(last.data.done).toBe(true);
    // Finished: the due date stays where it was rather than running past the end.
    expect(iso(last.data.dueDate)).toBe('2026-08-24');
    expect(last.nextDue).toBeNull();
  });

  it('never counts past the total, even if pressed again', () => {
    const s = planSettlement(installment(12));
    if (s.kind !== 'installment') throw new Error('unreachable');
    expect(s.paid).toBe(12);
    expect(s.data.done).toBe(true);
  });

  it('treats a plan with no payments recorded yet as its first', () => {
    const s = planSettlement({ ...installment(0), installmentsPaid: null });
    if (s.kind !== 'installment') throw new Error('unreachable');
    expect(s.paid).toBe(1);
    expect(s.data.done).toBe(false);
  });

  it('rolls a recurring bill forward and keeps it open to nag again', () => {
    const s = planSettlement({
      dueDate: new Date('2026-08-31T00:00:00Z'),
      cadence: 'quarterly',
      installmentsTotal: null,
      installmentsPaid: null,
    });
    expect(s.kind).toBe('recurring');
    if (s.kind !== 'recurring') throw new Error('unreachable');
    expect(iso(s.nextDue)).toBe('2026-11-30'); // Nov has no 31st
  });

  // Regression: plain setUTCMonth overflows, so a bill due the 31st used to
  // skip a whole month (Jan 31 + 1 month landed in March) and then nag on the
  // wrong date from then on.
  it('clamps to the end of a shorter month instead of overflowing it', () => {
    const monthly = (from: string) =>
      planSettlement({
        dueDate: new Date(`${from}T00:00:00Z`),
        cadence: 'monthly',
        installmentsTotal: null,
        installmentsPaid: null,
      });
    const due = (from: string) => {
      const s = monthly(from);
      if (s.kind !== 'recurring') throw new Error('unreachable');
      return iso(s.nextDue);
    };
    expect(due('2026-01-31')).toBe('2026-02-28');
    expect(due('2028-01-31')).toBe('2028-02-29'); // leap year
    expect(due('2026-03-31')).toBe('2026-04-30');
    // A day that exists in both months is untouched.
    expect(due('2026-01-15')).toBe('2026-02-15');
  });

  // With an anchor the schedule springs back: clamping alone made a bill due
  // the 31st sag to the 28th permanently once it passed February.
  it('returns to the anchor day after a short month', () => {
    const step = (from: string, anchor: number | null) => {
      const s = planSettlement({
        dueDate: new Date(`${from}T00:00:00Z`),
        cadence: 'monthly',
        installmentsTotal: null,
        installmentsPaid: null,
        dueAnchorDay: anchor,
      });
      if (s.kind !== 'recurring') throw new Error('unreachable');
      return iso(s.nextDue);
    };
    expect(step('2026-01-31', 31)).toBe('2026-02-28');
    expect(step('2026-02-28', 31)).toBe('2026-03-31'); // springs back
    expect(step('2026-04-30', 31)).toBe('2026-05-31');

    // Walking a year with the anchor never drifts off the month end.
    let d = '2026-01-31';
    const walked: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      d = step(d, 31) as string;
      walked.push(d);
    }
    expect(walked).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
    ]);
  });

  it('falls back to the due date own day when no anchor is stored', () => {
    const s = planSettlement({
      dueDate: new Date('2026-01-31T00:00:00Z'),
      cadence: 'monthly',
      installmentsTotal: null,
      installmentsPaid: null,
      dueAnchorDay: null,
    });
    if (s.kind !== 'recurring') throw new Error('unreachable');
    expect(iso(s.nextDue)).toBe('2026-02-28');
  });

  it('anchors installment plans too', () => {
    const s = planSettlement({
      dueDate: new Date('2026-02-28T00:00:00Z'),
      cadence: 'monthly',
      installmentsTotal: 12,
      installmentsPaid: 1,
      dueAnchorDay: 31,
    });
    if (s.kind !== 'installment') throw new Error('unreachable');
    expect(iso(s.data.dueDate)).toBe('2026-03-31');
  });

  it('reports nothing to advance for a one-off, the only dismissable case', () => {
    expect(
      planSettlement({
        dueDate: new Date('2026-08-24T00:00:00Z'),
        cadence: null,
        installmentsTotal: null,
        installmentsPaid: null,
      }).kind,
    ).toBe('nothing-to-advance');

    // An unrecognised cadence must not silently roll forward either.
    expect(
      planSettlement({
        dueDate: new Date('2026-08-24T00:00:00Z'),
        cadence: 'fortnightly',
        installmentsTotal: null,
        installmentsPaid: null,
      }).kind,
    ).toBe('nothing-to-advance');
  });
});

describe('planDeletion', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  // Removing the row would free the transaction for the next scan, which
  // read it straight back into the reminder just deleted.
  it('hides a reminder read from a transaction, and marks it done', () => {
    expect(planDeletion({ sourceTransactionId: 't1' }, now)).toEqual({
      kind: 'hide',
      data: { done: true, deletedAt: now },
    });
  });

  it('removes one typed in by hand, which no scan can re-read', () => {
    expect(planDeletion({ sourceTransactionId: null }, now)).toEqual({
      kind: 'remove',
    });
  });
});
