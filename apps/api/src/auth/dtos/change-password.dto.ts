import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDTO {
  /** Proves it is really the account holder at the keyboard, not a borrowed session. */
  @IsString()
  public readonly currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly newPassword!: string;
}
