import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSettlementDTO {
  /** Who paid the money back; absent = You. */
  @IsOptional()
  @IsUUID()
  public readonly fromFriendId?: string;

  /** Who received it; absent = You. */
  @IsOptional()
  @IsUUID()
  public readonly toFriendId?: string;

  @IsInt()
  @Min(1)
  public readonly amountCents!: number;

  @IsOptional()
  @IsDateString()
  public readonly date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly note?: string;
}
