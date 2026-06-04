export type CreateTransactionInput = {
  date: string;
  amount: number;
  subcategoryId: string;
  accountId: string;
  description?: string;
};

export type UpdateTransactionInput = Partial<
  Omit<CreateTransactionInput, 'accountId'>
>;
