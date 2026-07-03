import type { TransactionCategory } from './types/subcategory.types';

/** Seeded for every new user on registration. */
export const DEFAULT_SUBCATEGORIES: {
  name: string;
  category: TransactionCategory;
}[] = [
  { name: 'Salary', category: 'Income' },
  { name: 'Freelance', category: 'Income' },
  { name: 'Other Income', category: 'Income' },
  { name: 'Groceries', category: 'Expenses' },
  { name: 'Dining Out', category: 'Expenses' },
  { name: 'Transport', category: 'Expenses' },
  { name: 'Shopping', category: 'Expenses' },
  { name: 'Health', category: 'Expenses' },
  { name: 'Entertainment', category: 'Expenses' },
  { name: 'Rent', category: 'Bills' },
  { name: 'Utilities', category: 'Bills' },
  { name: 'Internet & Phone', category: 'Bills' },
  { name: 'Streaming', category: 'Subscriptions' },
  { name: 'Gym', category: 'Subscriptions' },
  { name: 'Loan Payment', category: 'Debts' },
  { name: 'Emergency Fund', category: 'Savings' },
];
