export type AccountType =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'credit'
  | 'investment'
  | 'crypto';

export type CreateAccountInput = {
  name: string;
  type: AccountType;
  currency: string;
  /** In minor currency units (cents). */
  initialBalance?: number;
};

export type UpdateAccountInput = Partial<CreateAccountInput>;

export type BalanceIntegrityEntry = {
  accountId: string;
  name: string;
  storedBalance: number;
  expectedBalance: number;
  /** storedBalance - expectedBalance; 0 means consistent. */
  drift: number;
};
