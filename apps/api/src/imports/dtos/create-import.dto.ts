import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ColumnMappingDTO } from './column-mapping.dto';

export class CreateImportDTO {
  @IsUUID()
  public readonly accountId!: string;

  @IsString()
  @MinLength(1)
  public readonly filename!: string;

  /** Raw CSV file contents. */
  @IsString()
  @MinLength(1)
  public readonly csv!: string;

  /** Optional; falls back to the account's saved mapping when omitted. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ColumnMappingDTO)
  public readonly mapping?: ColumnMappingDTO;

  /** Confidence at/above which a prediction is auto-accepted (default 0.7). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  public readonly threshold?: number;
}
