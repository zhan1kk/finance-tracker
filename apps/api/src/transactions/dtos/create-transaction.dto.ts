import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import type { TransactionType } from '../types/transaction.types';

const TRANSACTION_TYPES = ['INCOME', 'EXPENSE', 'TRANSFER'] as const;

export class CreateTransactionDTO {
  /** INCOME and EXPENSE require a subcategory; TRANSFER moves money to counterAccountId instead. */
  @IsIn(TRANSACTION_TYPES)
  public readonly type!: TransactionType;

  /** ISO 8601 date, e.g. "2026-07-02". */
  @IsDateString()
  public readonly date!: string;

  /** Amount in minor currency units (cents), always positive. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly amount!: number;

  /** Required for INCOME/EXPENSE; must not be set for TRANSFER. */
  @ValidateIf((dto: CreateTransactionDTO) => dto.type !== 'TRANSFER')
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsUUID()
  public readonly accountId!: string;

  /** Destination account. Required for TRANSFER; must not be set otherwise. */
  @ValidateIf((dto: CreateTransactionDTO) => dto.type === 'TRANSFER')
  @IsUUID()
  public readonly counterAccountId?: string;

  /** Optional: the EXPENSE transaction this INCOME reimburses. */
  @IsOptional()
  @IsUUID()
  public readonly parentTransactionId?: string;

  @IsOptional()
  @IsString()
  public readonly description?: string;
}
