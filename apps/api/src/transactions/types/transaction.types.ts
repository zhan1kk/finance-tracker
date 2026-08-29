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
  /** Comma-separated subcategory ids; matches any of them. */
  subcategoryIds?: string;
  type?: TransactionType;
  search?: string;
  sort?: 'date' | 'amount';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

export type UpdateTransactionInput = Partial<
  Omit<
    CreateTransactionInput,
    'accountId' | 'type' | 'counterAccountId' | 'parentTransactionId'
  >
>;

/** One slice of a split: a category (or internal) and the cents it takes. */
export type SplitPartInput = {
  amount: number;
  subcategoryId?: string;
  description?: string;
  excludeFromStats?: boolean;
};

/** Fields a bulk edit can set on many INCOME/EXPENSE rows at once. */
export type BulkUpdateInput = {
  subcategoryId?: string;
  excludeFromStats?: boolean;
};

export type StatsQuery = {
  from?: string;
  to?: string;
};

/** Per-month totals in cents. Expense is net of reimbursements received that month. */
export type MonthlyStat = {
  month: string;
  income: number;
  expense: number;
  /** Transactions recorded in the month. Distinguishes a month with no spending
   *  from one whose statement was never imported — which matters when months are
   *  averaged into a baseline. */
  count: number;
};

/** Spending on one calendar day in cents, netted like MonthlyStat.expense. */
export type DailyStat = {
  /** YYYY-MM-DD. Formatted in SQL so no timezone can shift it in transit. */
  day: string;
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
  /** Only days with activity; gaps are zero. */
  daily: DailyStat[];
  byCategory: CategoryStat[];
  /** Income per subcategory in cents (excludes reimbursements). */
  incomeByCategory: CategoryStat[];
};
