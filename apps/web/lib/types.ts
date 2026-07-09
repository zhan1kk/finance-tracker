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
  /** Present on create responses: non-blocking "unusual amount" warning. */
  outlier?: { direction: 'high' | 'low'; medianCents: number } | null;
};

export type TransactionList = {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
};

/** Per-month totals in cents; expense is net of reimbursements received that month. */
export type MonthlyStat = {
  month: string;
  income: number;
  expense: number;
};

/** Spending per subcategory in cents, net of linked reimbursements. */
export type CategoryStat = {
  subcategoryId: string;
  name: string;
  category: TransactionCategory;
  amount: number;
};

export type TransactionStats = {
  monthly: MonthlyStat[];
  byCategory: CategoryStat[];
};

export type TelegramSettings = {
  linked: boolean;
  defaultAccountId: string | null;
  botUsername: string | null;
};

export type TelegramLinkCode = {
  code: string;
  expiresAt: string;
  botUsername: string | null;
};

// ---- CSV import & categorization ----

export const DATE_FORMATS = [
  'ISO',
  'DD.MM.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export type ColumnMapping = {
  dateColumn: string;
  amountColumn: string;
  descriptionColumn: string;
  dateFormat?: DateFormat;
  decimalSeparator?: '.' | ',';
  negativeIsExpense?: boolean;
  hasHeader?: boolean;
};

export type ImportBatchStatus = 'PENDING_REVIEW' | 'COMMITTED' | 'UNDONE';
export type ImportRowStatus =
  | 'DUPLICATE'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'COMMITTED'
  | 'SKIPPED';
export type CategorizationSource = 'RULE' | 'LLM' | 'MANUAL' | 'NONE';

export type ImportRow = {
  id: string;
  rowIndex: number;
  date: string;
  /** Positive minor units (cents); sign is in `type`. */
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  description: string;
  status: ImportRowStatus;
  confidence: number | null;
  source: CategorizationSource;
  corrected: boolean;
  note: string | null;
  subcategoryId: string | null;
  subcategory: Subcategory | null;
  predictedSubcategory: { id: string; name: string } | null;
};

export type ImportBatch = {
  id: string;
  filename: string;
  status: ImportBatchStatus;
  threshold: number;
  provider: string;
  createdAt: string;
  committedAt: string | null;
  accountId: string;
  account: { id: string; name: string; currency: string };
  rows: ImportRow[];
};

export type SkippedRow = { rowIndex: number; reason: string; raw: unknown };

export type ImportResult = { batch: ImportBatch; skipped: SkippedRow[] };

export type ImportBatchSummary = {
  id: string;
  filename: string;
  status: ImportBatchStatus;
  provider: string;
  createdAt: string;
  account: { name: string };
  counts: Partial<Record<ImportRowStatus, number>>;
};

export type CsvInspection = {
  headers: string[];
  sample: Record<string, string>[];
};

export type CategorizationRule = {
  id: string;
  pattern: string;
  source: CategorizationSource;
  hitCount: number;
  subcategoryId: string;
  subcategory: { id: string; name: string };
};

export type AccuracyTally = {
  predicted: number;
  correct: number;
  accuracy: number | null;
};

export type AccuracyStats = {
  overall: AccuracyTally;
  bySource: { RULE: AccuracyTally; LLM: AccuracyTally };
  byBatch: (AccuracyTally & {
    batchId: string;
    filename: string;
    committedAt: string | null;
  })[];
};

// ---- recurring transactions ----

export const RECURRING_CADENCES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

// ---- budgets & reports ----

export const BUDGETABLE_CATEGORIES = [
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;

export type Budget = {
  id: string;
  monthlyLimit: number;
  subcategoryId: string | null;
  category: TransactionCategory | null;
  subcategory: { id: string; name: string; category: TransactionCategory } | null;
  spentCents: number;
  remainingCents: number;
  percent: number;
  overBudget: boolean;
};

export type NetWorthPoint = { month: string; netWorthCents: number };

export type RecurringRule = {
  id: string;
  type: 'INCOME' | 'EXPENSE';
  /** Positive minor units (cents). */
  amount: number;
  description: string | null;
  cadence: RecurringCadence;
  interval: number;
  startDate: string;
  nextRunAt: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrencesCreated: number;
  active: boolean;
  accountId: string;
  subcategoryId: string;
  account: { id: string; name: string; currency: string };
  subcategory: { id: string; name: string; category: TransactionCategory };
  annualizedCents: number;
  progress: number | null;
};
