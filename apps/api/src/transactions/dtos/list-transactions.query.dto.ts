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
