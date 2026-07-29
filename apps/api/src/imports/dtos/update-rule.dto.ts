import { IsOptional, IsUUID } from 'class-validator';

/** Exactly one target is expected; the service rejects zero or both. */
export class UpdateRuleDTO {
  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsOptional()
  @IsUUID()
  public readonly counterAccountId?: string;
}
