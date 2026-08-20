import { IsISO8601, IsOptional, IsString, Matches } from 'class-validator';

export class SyncRateDTO {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  public readonly currency!: string;

  /**
   * Fetch the rate as it was on this date instead of today's. Needed for older
   * transactions: without a rate on or before their date they fall back to a
   * rough built-in seed, which silently misprices them.
   */
  @IsOptional()
  @IsISO8601()
  public readonly date?: string;
}
