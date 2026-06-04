import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import type { TransactionCategory } from '../types/subcategory.types';

const TRANSACTION_CATEGORIES = [
  'Income',
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;

export class CreateSubcategoryDTO {
  @IsString()
  @IsNotEmpty()
  public readonly name!: string;

  @IsIn(TRANSACTION_CATEGORIES)
  public readonly category!: TransactionCategory;
}
