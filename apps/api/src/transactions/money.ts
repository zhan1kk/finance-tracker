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
