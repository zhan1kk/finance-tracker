import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

class SplitPartDTO {
  /** This part's slice of the original amount, in cents. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly amount!: number;

  /** Required unless the part is an internal move. */
  @ValidateIf((p: SplitPartDTO) => !p.excludeFromStats)
  @IsUUID()
  public readonly subcategoryId?: string;

  @IsOptional()
  @IsString()
  public readonly description?: string;

  @IsOptional()
  @IsBoolean()
  public readonly excludeFromStats?: boolean;
}

export class SplitTransactionDTO {
  /** Parts must add up to the original amount; at least two. */
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => SplitPartDTO)
  public readonly parts!: SplitPartDTO[];
}
