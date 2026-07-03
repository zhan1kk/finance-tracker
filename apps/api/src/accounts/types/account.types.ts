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

export type UpdateAccountInput = Partial<
  Omit<CreateAccountInput, 'initialBalance'>
>;
