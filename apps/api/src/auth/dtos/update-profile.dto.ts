import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class UpdateProfileDTO {
  /**
   * Day of the month a financial month begins (1 = calendar months). A month
   * then runs from this day to the day before it in the next month.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  public readonly monthStartDay?: number;

  /**
   * Currency that totals are presented in. Presentation only: amounts stay
   * stored in EUR and are converted at one current rate for display, so this
   * never rewrites anything and can be changed back freely.
   */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'baseCurrency must be a 3-letter ISO code',
  })
  public readonly baseCurrency?: string;
}
