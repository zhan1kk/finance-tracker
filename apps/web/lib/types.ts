export type User = {
  id: string;
  email: string;
  baseCurrency: string;
  /** Day of the month a financial month begins (1 = calendar months). */
  monthStartDay: number;
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

/** Currencies the app supports; the first is the base/reporting currency. */
/**
 * Suggestions for the currency pickers only — never a restriction. Any
 * three-letter code is accepted, and its rate is fetched on first use.
 */
export const COMMON_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'KZT',
  'TRY',
  'CHF',
  'PLN',
  'SEK',
  'JPY',
  'AED',
] as const;

// ---- split ledger (shared expenses with friends) ----

export type Friend = { id: string; name: string; createdAt: string };

export type SharedExpenseShare = {
  id: string;
  /** null = You. */
  friendId: string | null;
  amountCents: number;
};

export type SharedExpense = {
  id: string;
  description: string;
  amountCents: number;
  currency: string;
  date: string;
  /** null = You paid. */
  payerFriendId: string | null;
  splitMethod: string;
  shares: SharedExpenseShare[];
};

export type Settlement = {
  id: string;
  fromFriendId: string | null;
  toFriendId: string | null;
  amountCents: number;
  currency: string;
  date: string;
  note: string | null;
};

export type SplitBalances = {
  currency: string;
  /** Each: `fromName` owes `toName` `amountCents`. */
  balances: {
    fromId: string | null;
    fromName: string;
    toId: string | null;
    toName: string;
    amountCents: number;
  }[];
};

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Minor currency units (cents). */
  balance: number;
  initialBalance: number;
  /** Whether the account is part of the base-currency net worth. */
  countInNetWorth: boolean;
  /** Pinned accounts sort to the top of the list, separated from the rest. */
  pinned: boolean;
};

export type ExchangeRate = {
  id: string;
  currency: string;
  /** Date the rate takes effect (ISO). */
  date: string;
  /** Foreign units per 1 base unit (e.g. 540 = 540 KZT per 1 EUR). */
  rate: number;
};

export type FxRates = {
  currency: string;
  baseCurrency: string;
  defaultRate: number | null;
  effectiveRate: number;
  rates: ExchangeRate[];
};

/** Tracked foreign currencies and the exchange-fee spread the user set for each. */
export type FxPreferences = {
  baseCurrency: string;
  /** The currencies this user tracks — theirs, not a built-in list. */
  currencies: { currency: string; spreadPct: number; autoSync: boolean }[];
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
  /** One-tap shortcut in the Telegram capture picker. */
  pinned?: boolean;
};

export type TransactionType = 'INCOME' | 'EXPENSE' | 'TRANSFER';

export type Transaction = {
  id: string;
  type: TransactionType;
  date: string;
  /** Minor currency units (cents), in the account's currency. */
  amount: number;
  /** `amount` converted to the base currency (cents). */
  amountBase: number;
  description: string | null;
  accountId: string;
  subcategoryId: string | null;
  subcategory: Subcategory | null;
  counterAccountId: string | null;
  /** Internal move (own-account transfer / exchange): balance moves, excluded from stats. */
  excludeFromStats: boolean;
  parentTransactionId: string | null;
  reimbursements: Omit<Transaction, 'subcategory' | 'reimbursements'>[];
  /** Present on create responses: non-blocking "unusual amount" warning. */
  outlier?: { direction: 'high' | 'low'; medianCents: number } | null;
  /** Present on create responses: the (source) account's balance after booking. */
  balanceAfter?: number;
  /** Account balance after this transaction; present only when the list is
   * filtered to a single account (for reconciliation against a bank statement). */
  runningBalance?: number;
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
  /** Income per subcategory in cents (excludes reimbursements). */
  incomeByCategory: CategoryStat[];
};

export type TelegramSettings = {
  linked: boolean;
  defaultAccountId: string | null;
  botUsername: string | null;
  /** Opt-in nudges about payments coming due, sent to the linked chat. */
  remindersEnabled: boolean;
  /** Days before the due date the nudges start. */
  leadDays: number;
  /** Days between nudges inside that window. */
  intervalDays: number;
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
  /** The user's own annotation, merged into the transaction on commit. */
  userNote: string | null;
  subcategoryId: string | null;
  subcategory: Subcategory | null;
  predictedSubcategory: { id: string; name: string } | null;
  /** Set instead of subcategoryId when the row is a transfer between own accounts. */
  counterAccountId: string | null;
  counterAccount: { id: string; name: string } | null;
  /** Marked an internal move (own-account transfer / exchange), excluded from stats. */
  excludeFromStats: boolean;
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
  /** Which rows the rule applies to; TRANSFER rules match either direction. */
  type: TransactionType;
  /** Match the pattern only on word boundaries, not inside a longer word. */
  wholeWord: boolean;
  source: CategorizationSource;
  hitCount: number;
  /** Exactly one target is set: a subcategory, a counter account, or excludeFromStats. */
  subcategoryId: string | null;
  subcategory: { id: string; name: string } | null;
  counterAccountId: string | null;
  counterAccount: { id: string; name: string } | null;
  /** True for a learned "internal move" rule (no subcategory/counter account). */
  excludeFromStats: boolean;
};

export type Reminder = {
  id: string;
  label: string;
  /** payment = bill/subscription; ask = a friend owes you; pay = you owe a friend. */
  kind: "payment" | "ask" | "pay";
  /** ISO date of the next payment, or null if unknown. */
  dueDate: string | null;
  amountCents: number | null;
  currency: string | null;
  /** "monthly" / "quarterly" / "one-off" / … */
  cadence: string | null;
  /** Fixed-length installment plan: total payments and how many are done. */
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  note: string | null;
  done: boolean;
  subcategoryId: string | null;
  subcategory: { id: string; name: string; category: TransactionCategory } | null;
  sourceTransactionId: string | null;
  /** The transaction the reminder was read from (present on scanned ones). */
  sourceTransaction: {
    id: string;
    type: TransactionType;
    description: string | null;
  } | null;
  createdAt: string;
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
    /** Which categorizer ran, and the model behind it when there was one. */
    provider: string;
    model: string | null;
    /** PDF text extraction; null for CSV, which needs none. */
    extractMs: number | null;
    categorizeMs: number | null;
    /** Every row in the batch, not only the ones that got a prediction. */
    rows: number;
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

// Budgets are only for variable spending — Bills/Subscriptions are fixed
// recurring, Debts are exact payoffs, Savings are goals. All belong elsewhere.
export const BUDGETABLE_CATEGORIES = ['Expenses'] as const;

export type Budget = {
  id: string;
  /** Recurring default limit, used for any month without an override. */
  monthlyLimit: number;
  /** Financial-month label this row is computed for, e.g. "2026-06". */
  period: string;
  /** Effective limit for `period` (override if set, else monthlyLimit). */
  limit: number;
  /** True when `period` has its own limit that differs from the base. */
  isOverride: boolean;
  subcategoryId: string | null;
  category: TransactionCategory | null;
  subcategory: { id: string; name: string; category: TransactionCategory } | null;
  /** When set ("YYYY-MM"), the budget applies to that month only, not recurring. */
  oneOffPeriod: string | null;
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
