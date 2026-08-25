import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { TransactionType } from '../types/transaction.types';

export class ListTransactionsQueryDTO {
  /** Include transactions on or after this ISO date. */
  @IsOptional()
  @IsDateString()
  public readonly from?: string;

  /** Include transactions on or before this ISO date. */
  @IsOptional()
  @IsDateString()
  public readonly to?: string;

  @IsOptional()
  @IsUUID()
  public readonly accountId?: string;

  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  /** Comma-separated subcategory ids — filters to any of them (multi-select). */
  @IsOptional()
  @IsString()
  public readonly subcategoryIds?: string;

  @IsOptional()
  @IsIn(['INCOME', 'EXPENSE', 'TRANSFER'])
  public readonly type?: TransactionType;

  /** Case-insensitive search in the description. */
  @IsOptional()
  @IsString()
  public readonly search?: string;

  /** What to order by. "amount" sorts on the base-currency value, so a KZT and
   *  a EUR row compare meaningfully rather than by raw digits. */
  @IsOptional()
  @IsIn(['date', 'amount'])
  public readonly sort?: 'date' | 'amount';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  public readonly dir?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public readonly pageSize?: number;
}
