import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

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
}
