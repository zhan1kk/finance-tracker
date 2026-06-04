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
  initialBalance?: number;
};

export type UpdateAccountInput = Partial<CreateAccountInput>;
