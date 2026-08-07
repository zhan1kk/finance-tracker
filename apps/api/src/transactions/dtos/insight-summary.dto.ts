import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class InsightSummaryDTO {
  @IsString()
  @MaxLength(60)
  public readonly month!: string;

  /** One-line overall-spend fact (already formatted), if any. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  public readonly overall?: string;

  /** Per-category mover facts (already formatted). */
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  public readonly movers!: string[];
}
