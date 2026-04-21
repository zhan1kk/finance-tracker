export type TransactionCategory =
  | 'Income'
  | 'Expenses'
  | 'Bills'
  | 'Subscriptions'
  | 'Debts'
  | 'Savings';

export type Transaction = {
  id: string;
  date: string;
  amount: number;
  subcategory: string;
  category: TransactionCategory;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTransactionInput = {
  date: string;
  amount: number;
  subcategory: string;
  category: TransactionCategory;
  description?: string;
};

export type UpdateTransactionInput = Partial<CreateTransactionInput>;
