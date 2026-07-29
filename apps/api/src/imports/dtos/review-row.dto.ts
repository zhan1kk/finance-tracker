import { IsOptional, IsUUID } from 'class-validator';

/** Exactly one target is expected; the service rejects zero or both. */
export class ReviewRowDTO {
  /** The corrected subcategory for this row. */
  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  /** Or: the other account, marking this row a transfer between own accounts. */
  @IsOptional()
  @IsUUID()
  public readonly counterAccountId?: string;
}
