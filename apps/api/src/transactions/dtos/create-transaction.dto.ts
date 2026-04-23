import { Type } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsNotEmpty,
  IsIn,
  Min,
} from 'class-validator';
import type { TransactionCategory } from '../types/transaction.types';

const TRANSACTION_CATEGORY = [
  'Income',
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;

export class CreateTransactionDTO {
  @IsString()
  @IsNotEmpty()
  public readonly date!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  public readonly amount!: number;

  @IsString()
  @IsNotEmpty()
  public readonly subcategory!: string;

  @IsIn(TRANSACTION_CATEGORY)
  public readonly category!: TransactionCategory;
  // how to handle auto-selection of category (based on sub categories)

  @IsOptional()
  @IsString()
  public readonly description?: string;
}
