import { allocateProportionally, effectOnAccount, signedDelta } from './money';

describe('signedDelta', () => {
  it('income adds, expense subtracts', () => {
    expect(signedDelta('INCOME', 500)).toBe(500);
    expect(signedDelta('EXPENSE', 500)).toBe(-500);
  });
});

describe('effectOnAccount', () => {
  const transfer = {
    type: 'TRANSFER' as const,
    amount: 300,
    accountId: 'src',
    counterAccountId: 'dst',
  };

  it('income/expense affect only their own account', () => {
    expect(
      effectOnAccount({ type: 'INCOME', amount: 100, accountId: 'a' }, 'a'),
    ).toBe(100);
    expect(
      effectOnAccount({ type: 'EXPENSE', amount: 100, accountId: 'a' }, 'a'),
    ).toBe(-100);
    expect(
      effectOnAccount({ type: 'INCOME', amount: 100, accountId: 'a' }, 'b'),
    ).toBe(0);
  });

  it('transfer subtracts from source, adds to counter, ignores others', () => {
    expect(effectOnAccount(transfer, 'src')).toBe(-300);
    expect(effectOnAccount(transfer, 'dst')).toBe(300);
    expect(effectOnAccount(transfer, 'other')).toBe(0);
  });
});

describe('allocateProportionally', () => {
  // The split drift: two halves of $1.50 at 1.08 each convert to 69, against
  // the whole's 139. Shared out, they add back up to the whole.
  it('adds up exactly where rounding each part would not', () => {
    const parts = allocateProportionally(139, [75, 75]);
    expect(parts).toEqual([70, 69]);
    expect(parts[0] + parts[1]).toBe(139);
  });

  it('gives a euro split its own amounts back', () => {
    expect(allocateProportionally(1_234, [1_000, 234])).toEqual([1_000, 234]);
  });

  it('hands the leftover to whichever part lost the most', () => {
    // Exact shares 33.33, 33.33, 33.33 — then 66.6 vs 33.3 below.
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(100, [1, 2])).toEqual([33, 67]);
  });

  it('stays exact past 2^53', () => {
    const total = 9_000_000_000_000;
    const parts = allocateProportionally(total, [3_333, 3_333, 3_334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
  });
});
