import { IsBoolean } from 'class-validator';

export class SkipRowDTO {
  /** true drops the row from the import; false restores it for review. */
  @IsBoolean()
  public readonly skipped!: boolean;
}
