import {
  computeBalances,
  parseScope,
  scopeWhere,
  yourPosition,
} from './split-balances';

const friends = [
  { id: 'anna', name: 'Anna' },
  { id: 'ben', name: 'Ben' },
];
const share = (friendId: string | null, amountCents: number) => ({
  friendId,
  amountCents,
});

describe('computeBalances', () => {
  it('turns a dinner you paid into what each friend owes you', () => {
    const balances = computeBalances(
      friends,
      [
        {
          payerFriendId: null,
          shares: [
            share(null, 3_000),
            share('anna', 3_000),
            share('ben', 3_000),
          ],
        },
      ],
      [],
    );
    expect(balances).toEqual([
      expect.objectContaining({
        fromName: 'Anna',
        toName: 'You',
        amountCents: 3_000,
      }),
      expect.objectContaining({
        fromName: 'Ben',
        toName: 'You',
        amountCents: 3_000,
      }),
    ]);
    expect(yourPosition(balances)).toEqual({
      owedToYouCents: 6_000,
      youOweCents: 0,
    });
  });

  it('nets opposite debts between the same two people to one line', () => {
    const balances = computeBalances(
      friends,
      [
        { payerFriendId: null, shares: [share('anna', 5_000)] },
        { payerFriendId: 'anna', shares: [share(null, 2_000)] },
      ],
      [],
    );
    expect(balances).toEqual([
      expect.objectContaining({
        fromId: 'anna',
        toId: null,
        amountCents: 3_000,
      }),
    ]);
  });

  // A group counts as settled exactly when this comes back empty.
  it('returns nothing once a settlement pays the debt off', () => {
    const balances = computeBalances(
      friends,
      [{ payerFriendId: null, shares: [share('anna', 4_000)] }],
      [{ fromFriendId: 'anna', toFriendId: null, amountCents: 4_000 }],
    );
    expect(balances).toEqual([]);
  });

  it('lists debts involving you before those between friends', () => {
    const balances = computeBalances(
      friends,
      [
        { payerFriendId: 'ben', shares: [share('anna', 9_000)] },
        { payerFriendId: null, shares: [share('ben', 1_000)] },
      ],
      [],
    );
    expect(balances.map((b) => [b.fromName, b.toName])).toEqual([
      ['Ben', 'You'],
      ['Anna', 'Ben'],
    ]);
  });
});

describe('split scopes', () => {
  it('reads ?group= as everything, nothing-in-a-group, or one group', () => {
    expect(scopeWhere(parseScope(undefined))).toEqual({});
    expect(scopeWhere(parseScope('none'))).toEqual({ groupId: null });
    expect(scopeWhere(parseScope('g1'))).toEqual({ groupId: 'g1' });
  });
});
