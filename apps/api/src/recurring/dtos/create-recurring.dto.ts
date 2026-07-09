import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateRecurringDTO {
  @IsIn(['INCOME', 'EXPENSE'])
  public readonly type!: 'INCOME' | 'EXPENSE';

  /** Positive minor units (cents). */
  @IsInt()
  @Min(1)
  public readonly amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly description?: string;

  @IsUUID()
  public readonly accountId!: string;

  @IsUUID()
  public readonly subcategoryId!: string;

  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
  public readonly cadence!: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly interval?: number;

  /** First occurrence date (ISO). */
  @IsDateString()
  public readonly startDate!: string;

  @IsOptional()
  @IsDateString()
  public readonly endDate?: string;

  /** Installments: stop after this many occurrences. */
  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly maxOccurrences?: number;
}
