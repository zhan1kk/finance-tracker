import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { DATE_FORMATS, type DateFormat } from '../parsing';

export class ColumnMappingDTO {
  @IsString()
  public readonly dateColumn!: string;

  @IsString()
  public readonly amountColumn!: string;

  @IsString()
  public readonly descriptionColumn!: string;

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
