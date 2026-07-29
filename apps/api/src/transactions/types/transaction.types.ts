export type TransactionType = 'INCOME' | 'EXPENSE' | 'TRANSFER';

export type CreateTransactionInput = {
  type: TransactionType;
  date: string;
  amount: number;
  accountId: string;
  /** Required for INCOME/EXPENSE, forbidden for TRANSFER. */
  subcategoryId?: string;
  /** Destination account; required for TRANSFER, forbidden otherwise. */
  counterAccountId?: string;
  /** Links an INCOME to the EXPENSE it reimburses. */
  parentTransactionId?: string;
  description?: string;
  /** Marks an internal move: keeps the balance effect, drops it from stats. */
  excludeFromStats?: boolean;
};

export type ListTransactionsQuery = {
  from?: string;
  to?: string;
  accountId?: string;
  subcategoryId?: string;
  type?: TransactionType;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type UpdateTransactionInput = Partial<
  Omit<
    CreateTransactionInput,
    'accountId' | 'type' | 'counterAccountId' | 'parentTransactionId'
  >
>;

export type StatsQuery = {
  from?: string;
  to?: string;
};

/** Per-month totals in cents. Expense is net of reimbursements received that month. */
export type MonthlyStat = {
  month: string;
  income: number;
  expense: number;
};

/** Spending per subcategory in cents, net of reimbursements linked to its expenses. */
export type CategoryStat = {
  subcategoryId: string;
  name: string;
  category: string;
  amount: number;
};

export type TransactionStats = {
  monthly: MonthlyStat[];
  byCategory: CategoryStat[];
  /** Income per subcategory in cents (excludes reimbursements). */
  incomeByCategory: CategoryStat[];
};
