import type { TransactionCategory } from './types/subcategory.types';

/** Seeded for every new user on registration. */
export const DEFAULT_SUBCATEGORIES: {
  name: string;
  category: TransactionCategory;
}[] = [
  { name: 'Salary', category: 'Income' },
  { name: 'Freelance', category: 'Income' },
  { name: 'Other Income', category: 'Income' },
  // Somewhere to file money coming back (a return, a friend paying you back).
  // Nothing keys off this name: what makes a payback behave like a refund is
  // linking it to the expense it repays, not the category it sits in.
  { name: 'Refunds', category: 'Income' },
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
