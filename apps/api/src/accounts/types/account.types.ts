export type AccountType =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'credit'
  | 'investment'
  | 'crypto';

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateAccountInput = {
  name: string;
  type: AccountType;
  currency: string;
  initialBalance?: number;
};

export type UpdateAccountInput = Partial<
  Omit<CreateAccountInput, 'initialBalance'>
>;
