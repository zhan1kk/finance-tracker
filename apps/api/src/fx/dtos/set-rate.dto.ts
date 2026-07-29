import { IsNumber, IsPositive, IsString, Matches } from 'class-validator';

export class SetRateDTO {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  public readonly currency!: string;

  /** Calendar date the rate takes effect, `YYYY-MM-DD`. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  public readonly date!: string;

  /** Foreign units per 1 base unit (e.g. 540 for 540 KZT = 1 EUR). */
  @IsNumber()
  @IsPositive()
  public readonly rate!: number;
}
