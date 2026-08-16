import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDTO {
  @IsEmail()
  public readonly email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password!: string;

  /** Currency used for aggregated reports. Defaults to EUR. */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'baseCurrency must be a 3-letter ISO code',
  })
  public readonly baseCurrency?: string;

  /** Required when the server has INVITE_CODE set; ignored otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly inviteCode?: string;
}
