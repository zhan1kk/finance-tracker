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
