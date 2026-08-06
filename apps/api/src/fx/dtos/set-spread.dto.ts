import { IsNumber, Max, Min } from 'class-validator';

export class SetSpreadDTO {
  /** Exchange fee percentage the bank charges (0–10). */
  @IsNumber()
  @Min(0)
  @Max(10)
  public readonly spreadPct!: number;
}
