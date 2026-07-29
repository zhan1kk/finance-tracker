import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * At most one target; the service rejects more than one. A request may also
 * carry only `userNote` — annotating a row without (re)categorizing it.
 */
export class ReviewRowDTO {
  /** The corrected subcategory for this row. */
  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  /** Or: the other account, marking this row a transfer between own accounts. */
  @IsOptional()
  @IsUUID()
  public readonly counterAccountId?: string;

  /** Or: mark this row an internal move (own-account transfer / exchange),
   * kept out of income/spending stats. */
  @IsOptional()
  @IsBoolean()
  public readonly excludeFromStats?: boolean;

  /** Personal annotation, merged into the transaction's description on commit.
   * Empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly userNote?: string;
}
