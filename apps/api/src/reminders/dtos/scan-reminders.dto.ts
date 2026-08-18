import { IsISO8601, IsOptional } from 'class-validator';

export class ScanRemindersDTO {
  /**
   * Only read descriptions from this date onwards. Omitted means the most
   * recent transactions (capped), which is the right default for a routine
   * scan; set it to go back further and pick up older notes.
   */
  @IsOptional()
  @IsISO8601()
  public readonly since?: string;
}
