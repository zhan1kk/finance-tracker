import { IsDefined, IsUUID, ValidateIf } from 'class-validator';

export class UpdateTelegramSettingsDTO {
  /** Account the bot books captures against; null clears it. */
  @IsDefined()
  @ValidateIf((o: UpdateTelegramSettingsDTO) => o.defaultAccountId !== null)
  @IsUUID()
  public readonly defaultAccountId!: string | null;
}
