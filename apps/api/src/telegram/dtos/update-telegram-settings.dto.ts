import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateTelegramSettingsDTO {
  /** Account the bot books captures against; null clears it. */
  @IsOptional()
  @ValidateIf((o: UpdateTelegramSettingsDTO) => o.defaultAccountId !== null)
  @IsUUID()
  public readonly defaultAccountId?: string | null;

  /** Opt in to reminder nudges in the linked chat. */
  @IsOptional()
  @IsBoolean()
  public readonly remindersEnabled?: boolean;

  /** Days before a payment the nudges start. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  public readonly leadDays?: number;

  /** Days between nudges within that window. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  public readonly intervalDays?: number;
}
