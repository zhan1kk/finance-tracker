import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/** Exactly one target is expected; the service rejects zero or both. */
export class CreateRuleDTO {
  /** Substring matched (case-insensitively) against a row's normalized merchant. */
  @IsString()
  @MinLength(1)
  public readonly pattern!: string;

  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  /** Or: matching rows are transfers to/from this account of mine. */
  @IsOptional()
  @IsUUID()
  public readonly counterAccountId?: string;
}
