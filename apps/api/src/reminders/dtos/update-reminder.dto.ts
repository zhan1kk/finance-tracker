import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateReminderDTO {
  /** Mark the reminder handled/dismissed (or un-dismiss it). */
  @IsOptional()
  @IsBoolean()
  public readonly done?: boolean;
}
