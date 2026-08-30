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

export type UpdateSubcategoryInput = Partial<CreateSubcategoryInput> & {
  /** One-tap shortcut in the Telegram capture picker. */
  pinned?: boolean;
  /** Retire it (true) or bring it back (false). */
  archived?: boolean;
};
