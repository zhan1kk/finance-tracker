import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateRecurringDTO {
  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly description?: string;

  @IsOptional()
  @IsDateString()
  public readonly endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  public readonly maxOccurrences?: number;

  /** Pause or resume the rule. */
  @IsOptional()
  @IsBoolean()
  public readonly active?: boolean;
}
