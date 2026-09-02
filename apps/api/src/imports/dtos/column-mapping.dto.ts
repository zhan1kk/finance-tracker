import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { DATE_FORMATS, type DateFormat } from '../parsing';

export class ColumnMappingDTO {
  @IsString()
  public readonly dateColumn!: string;

  @IsString()
  public readonly amountColumn!: string;

  @IsString()
  public readonly descriptionColumn!: string;

  /** Column holding a per-transaction fee, when the bank reports one separately
   *  (Revolut's "Fee"). Omit when the export has no such column. */
  @IsOptional()
  @IsString()
  public readonly feeColumn?: string;

  @IsOptional()
  @IsIn(DATE_FORMATS)
  public readonly dateFormat?: DateFormat;

  @IsOptional()
  @IsIn(['.', ','])
  public readonly decimalSeparator?: '.' | ',';

  @IsOptional()
  @IsBoolean()
  public readonly negativeIsExpense?: boolean;

  @IsOptional()
  @IsBoolean()
  public readonly hasHeader?: boolean;
}
