import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const REMINDER_CADENCES = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
  'one-off',
] as const;

export class CreateReminderDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  public readonly label!: string;

  /** Optional category (a subcategory), for subscriptions/bills. */
  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  /** Next payment date, ISO "YYYY-MM-DD". */
  @IsOptional()
  @IsDateString()
  public readonly dueDate?: string;

  /** Amount in minor currency units (cents). */
  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly amountCents?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  public readonly currency?: string;

  @IsOptional()
  @IsIn(REMINDER_CADENCES)
  public readonly cadence?: string;

  /** Total payments for a fixed-length installment plan (e.g. 3 for "1/3"). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(120)
  public readonly installmentsTotal?: number;

  /** How many of those are already done (defaults to 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly installmentsPaid?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly note?: string;
}
