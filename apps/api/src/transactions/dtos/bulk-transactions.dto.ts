import {
  ArrayMinSize,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

/** Apply a category and/or the internal flag to many rows at once. */
export class BulkUpdateTransactionsDTO {
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  public readonly ids!: string[];

  @IsOptional()
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
