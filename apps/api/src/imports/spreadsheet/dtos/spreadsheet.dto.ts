import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { TransactionCategory } from '../../../subcategories/types/subcategory.types';

const TRANSACTION_CATEGORIES = [
  'Income',
  'Expenses',
  'Bills',
  'Subscriptions',
  'Debts',
  'Savings',
] as const;

/** ~6 MB of base64 ≈ a 4.5 MB workbook; the reader enforces its own cap too. */
const MAX_BASE64_LENGTH = 6_000_000;

export class PreviewSpreadsheetDTO {
  /** The .xlsx file, base64-encoded. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BASE64_LENGTH, { message: 'Spreadsheet is too large' })
  public readonly file!: string;
}

export class ImportBudgetItemDTO {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  public readonly name!: string;

  @IsIn(TRANSACTION_CATEGORIES)
  public readonly category!: TransactionCategory;

  /** Monthly limit in cents. Omit (or null) to create the subcategory only. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly budgetCents?: number | null;
}

export class ApplySpreadsheetDTO {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ImportBudgetItemDTO)
  public readonly items!: ImportBudgetItemDTO[];
}
