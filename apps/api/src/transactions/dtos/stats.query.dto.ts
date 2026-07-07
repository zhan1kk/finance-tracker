import { IsDateString, IsOptional } from 'class-validator';

export class StatsQueryDTO {
  /** Include transactions on or after this ISO date. */
  @IsOptional()
  @IsDateString()
  public readonly from?: string;

  /** Include transactions on or before this ISO date. */
  @IsOptional()
  @IsDateString()
  public readonly to?: string;
}
