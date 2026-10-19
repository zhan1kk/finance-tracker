import type { TransactionType } from './types/transaction.types';

/**
 * Pure balance math for transactions, kept separate from the service so the
 * money rules (the riskiest part) can be unit-tested in isolation.
 */

/** Signed balance effect (cents) of an INCOME/EXPENSE on its own account. */
export function signedDelta(type: TransactionType, amount: number): number {
  return type === 'INCOME' ? amount : -amount;
}

/**
 * The signed change a transaction makes to one account's balance: income adds
 * and expense subtracts on their own account; a transfer subtracts from its
 * source account and adds to its counter account; otherwise 0.
 */
export function effectOnAccount(
  txn: {
    type: TransactionType;
    amount: number;
    accountId: string;
    counterAccountId?: string | null;
  },
  accountId: string,
): number {
  if (txn.type === 'TRANSFER') {
    if (txn.accountId === accountId) return -txn.amount;
    if (txn.counterAccountId === accountId) return txn.amount;
    return 0;
  }
  return txn.accountId === accountId ? signedDelta(txn.type, txn.amount) : 0;
}

/**
 * Divides a non-negative `total` into whole parts proportional to `weights`,
 * adding up to `total` exactly. Largest remainder: each part takes its floor,
 * and what is left goes a unit at a time to the parts that lost the most to
 * rounding (ties to the earlier part). BigInt, because total × weight can pass
 * 2^53 for amounts a ledger can hold.
 */
export function allocateProportionally(
  total: number,
  weights: number[],
): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0 || total < 0) {
    throw new Error('allocateProportionally needs positive weights');
  }
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w, i) => {
    const exact = T * BigInt(w);
    return { i, floor: exact / S, rem: exact % S };
  });
  const result = parts.map((p) => p.floor);
  let left = T - result.reduce((a, f) => a + f, BigInt(0));
  const byLoss = [...parts].sort((a, b) =>
    b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i,
  );
  for (const p of byLoss) {
    if (left <= BigInt(0)) break;
    result[p.i] += BigInt(1);
    left -= BigInt(1);
  }
  return result.map(Number);
}
