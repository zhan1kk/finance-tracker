export type TransactionCategory =
  | 'Income'
  | 'Expenses'
  | 'Bills'
  | 'Subscriptions'
  | 'Debts'
  | 'Savings';

export type CreateSubcategoryInput = {
  name: string;
  category: TransactionCategory;
};

export type UpdateSubcategoryInput = Partial<CreateSubcategoryInput>;
