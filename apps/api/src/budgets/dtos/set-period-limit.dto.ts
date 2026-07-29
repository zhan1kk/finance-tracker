import { IsInt, Min } from 'class-validator';

/** A per-month override of a budget's limit (cents). */
export class SetPeriodLimitDTO {
  @IsInt()
  @Min(1)
  public readonly limit!: number;
}
