import {
  ArrayMinSize,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';

/** Apply a category and/or the internal flag to many rows at once. */
export class BulkUpdateTransactionsDTO {
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  public readonly ids!: string[];

  /** Optional, but not nullable: IsOptional would let null through, and there
   *  is no "clear the category" in bulk. */
  @ValidateIf((_dto, value) => value !== undefined)
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsOptional()
  @IsBoolean()
  public readonly excludeFromStats?: boolean;
}

/** Delete many rows at once. */
export class BulkDeleteTransactionsDTO {
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  public readonly ids!: string[];
}
