import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PreviewRulesDTO {
  /** Candidate patterns to try against the user's existing transactions. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  public readonly patterns!: string[];
}

class BulkRuleDTO {
  @IsString()
  @MinLength(1)
  public readonly pattern!: string;

  @IsOptional()
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsOptional()
  @IsUUID()
  public readonly counterAccountId?: string;
}

export class BulkCreateRulesDTO {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkRuleDTO)
  public readonly rules!: BulkRuleDTO[];
}
