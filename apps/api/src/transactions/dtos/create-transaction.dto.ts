import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateTransactionDTO {
  /** ISO 8601 date, e.g. "2026-07-02". */
  @IsDateString()
  public readonly date!: string;

  /** Amount in minor currency units (cents), always positive. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly amount!: number;

  @IsUUID()
  public readonly subcategoryId!: string;

  @IsUUID()
  public readonly accountId!: string;

  @IsOptional()
  @IsString()
  public readonly description?: string;
}
