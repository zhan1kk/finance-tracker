export type User = {
  id: string;
  email: string;
  baseCurrency: string;
};

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'credit',
  'investment',
  'crypto',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Minor currency units (cents). */
  balance: number;
  initialBalance: number;
};

export const TRANSACTION_CATEGORIES = [
  'Income',
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export type Subcategory = {
  id: string;
  name: string;
  category: TransactionCategory;
};

export type TransactionType = 'INCOME' | 'EXPENSE' | 'TRANSFER';

export type Transaction = {
  id: string;
  type: TransactionType;
  date: string;
  /** Minor currency units (cents). */
  amount: number;
  description: string | null;
  accountId: string;
  subcategoryId: string | null;
  subcategory: Subcategory | null;
  counterAccountId: string | null;
  parentTransactionId: string | null;
  reimbursements: Omit<Transaction, 'subcategory' | 'reimbursements'>[];
};

export type TransactionList = {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
};
