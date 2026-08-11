import { IsIn, IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';
import type { TransactionCategory } from '../../subcategories/types/subcategory.types';

/** Spending categories a budget can target (Income is not a spend budget). */
export const BUDGETABLE_CATEGORIES = [
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;

export class CreateBudgetDTO {
  /** Monthly limit in minor currency units (cents). */
  @IsInt()
  @Min(1)
  public readonly monthlyLimit!: number;

  /** Scope: exactly one of subcategoryId or category (enforced in the service). */
  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsOptional()
  @IsIn(BUDGETABLE_CATEGORIES)
  public readonly category?: Exclude<TransactionCategory, 'Income'>;

  /** When set ("YYYY-MM"), the budget applies to that financial month only. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'oneOffPeriod must be a "YYYY-MM" label',
  })
  public readonly oneOffPeriod?: string;
}
