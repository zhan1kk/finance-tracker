import { IsString, IsUUID, MinLength } from 'class-validator';

export class CreateRuleDTO {
  /** Substring matched (case-insensitively) against a row's normalized merchant. */
  @IsString()
  @MinLength(1)
  public readonly pattern!: string;

  @IsUUID()
  public readonly subcategoryId!: string;
}
