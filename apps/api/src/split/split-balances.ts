/**
 * Who owes whom, as a pure function of expenses and settlements.
 *
 * Pulled out of SplitService.balances() when groups arrived, because the same
 * netting now runs for several scopes — everything, what is not in a group, and
 * each group on its own — and a group counts as settled exactly when this
 * returns nothing for it. One function, so "settled" can never mean something
 * different from the balances shown beside it.
 */

/** The key used for the user themselves in the debt graph (null friend id). */
export const YOU = 'you';

export type ExpenseLite = {
  payerFriendId: string | null;
  shares: { friendId: string | null; amountCents: number }[];
};

export type SettlementLite = {
  fromFriendId: string | null;
  toFriendId: string | null;
  amountCents: number;
};

export type PairBalance = {
  fromId: string | null;
  fromName: string;
  toId: string | null;
  toName: string;
  amountCents: number;
};

/**
 * Each expense adds a debt from each participant (other than the payer) to the
 * payer; each settlement pays a debt down. Nets each unordered pair to a single
 * direction, and lists only the non-zero ones — those involving You first, then
 * the largest.
 */
export function computeBalances(
  friends: { id: string; name: string }[],
  expenses: ExpenseLite[],
  settlements: SettlementLite[],
): PairBalance[] {
  // owe.get(`${from}|${to}`) = how much `from` owes `to`.
  const owe = new Map<string, number>();
  const add = (from: string, to: string, amount: number) => {
    if (from === to || amount === 0) return;
    const key = `${from}|${to}`;
    owe.set(key, (owe.get(key) ?? 0) + amount);
  };
  for (const e of expenses) {
    const payer = e.payerFriendId ?? YOU;
    for (const s of e.shares) {
      const party = s.friendId ?? YOU;
      if (party !== payer) add(party, payer, s.amountCents);
    }
  }
  for (const st of settlements) {
    add(st.fromFriendId ?? YOU, st.toFriendId ?? YOU, -st.amountCents);
  }

  const nameOf = new Map(friends.map((f) => [f.id, f.name]));
  const label = (key: string) =>
    key === YOU ? 'You' : (nameOf.get(key) ?? '(removed)');
  const idOf = (key: string) => (key === YOU ? null : key);

  const parties = [YOU, ...friends.map((f) => f.id)];
  const seen = new Set<string>();
  const balances: PairBalance[] = [];
  for (const a of parties) {
    for (const b of parties) {
      if (a === b) continue;
      const pair = [a, b].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      const net = (owe.get(`${a}|${b}`) ?? 0) - (owe.get(`${b}|${a}`) ?? 0);
      if (net === 0) continue;
      const [from, to] = net > 0 ? [a, b] : [b, a];
      balances.push({
        fromId: idOf(from),
        fromName: label(from),
        toId: idOf(to),
        toName: label(to),
        amountCents: Math.abs(net),
      });
    }
  }
  balances.sort((x, y) => {
    const xYou = x.fromId === null || x.toId === null ? 0 : 1;
    const yYou = y.fromId === null || y.toId === null ? 0 : 1;
    return xYou - yYou || y.amountCents - x.amountCents;
  });
  return balances;
}

/** Your side of it: what you are owed and what you owe, in total. */
export function yourPosition(balances: PairBalance[]): {
  owedToYouCents: number;
  youOweCents: number;
} {
  let owedToYouCents = 0;
  let youOweCents = 0;
  for (const b of balances) {
    if (b.toId === null) owedToYouCents += b.amountCents;
    if (b.fromId === null) youOweCents += b.amountCents;
  }
  return { owedToYouCents, youOweCents };
}

/** Which slice of the ledger a request covers. */
export type SplitScope =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'group'; id: string };

/** `?group=` as the controllers receive it: an id, "none", or absent. */
export function parseScope(group: string | undefined): SplitScope {
  if (group === undefined) return { kind: 'all' };
  if (group === 'none') return { kind: 'none' };
  return { kind: 'group', id: group };
}

/** The Prisma filter for a scope, on SharedExpense or Settlement. */
export function scopeWhere(scope: SplitScope): { groupId?: string | null } {
  if (scope.kind === 'all') return {};
  if (scope.kind === 'none') return { groupId: null };
  return { groupId: scope.id };
}
