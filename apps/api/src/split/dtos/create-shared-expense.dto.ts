import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class ParticipantDTO {
  /** Absent/omitted = You. */
  @IsOptional()
  @IsUUID()
  public readonly friendId?: string;

  /** Required for an "exact" split; ignored for "equal". */
  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly amountCents?: number;
}

export class CreateSharedExpenseDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public readonly description!: string;

  /** Total in minor units (cents). */
  @IsInt()
  @Min(1)
  public readonly amountCents!: number;

  @IsDateString()
  public readonly date!: string;

  /** Who paid; absent = You. */
  @IsOptional()
  @IsUUID()
  public readonly payerFriendId?: string;

  @IsIn(['equal', 'exact'])
  public readonly splitMethod!: 'equal' | 'exact';

  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ParticipantDTO)
  public readonly participants!: ParticipantDTO[];

  /** The group it belongs to; absent = not in a group. */
  @IsOptional()
  @IsUUID()
  public readonly groupId?: string;
}
