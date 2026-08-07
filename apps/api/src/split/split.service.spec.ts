import { computeShares } from './split.service';

const P = (friendId?: string, amountCents?: number) => ({ friendId, amountCents });

describe('computeShares', () => {
  it('splits equally and hands the remainder to the first participants', () => {
    const shares = computeShares('equal', 100, [P('a'), P('b'), P()]);
    expect(shares.map((s) => s.amountCents)).toEqual([34, 33, 33]);
    // Always sums back to the exact total.
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(100);
    // null friendId is preserved as "You".
    expect(shares[2].friendId).toBeNull();
  });

  it('splits evenly when it divides cleanly', () => {
    const shares = computeShares('equal', 900, [P('a'), P('b'), P('c')]);
    expect(shares.map((s) => s.amountCents)).toEqual([300, 300, 300]);
  });

  it('accepts exact shares that add up to the total', () => {
    const shares = computeShares('exact', 100, [P('a', 70), P(undefined, 30)]);
    expect(shares).toEqual([
      { friendId: 'a', amountCents: 70 },
      { friendId: null, amountCents: 30 },
    ]);
  });

  it('rejects exact shares that do not add up, or are negative', () => {
    expect(() => computeShares('exact', 100, [P('a', 70), P('b', 20)])).toThrow();
    expect(() => computeShares('exact', 100, [P('a', 120), P('b', -20)])).toThrow();
  });
});
