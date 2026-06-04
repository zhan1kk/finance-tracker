import { Type } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsNotEmpty,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateTransactionDTO {
  @IsString()
  @IsNotEmpty()
  public readonly date!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  public readonly amount!: number;

  @IsUUID()
  public readonly subcategoryId!: string;

  @IsUUID()
  public readonly accountId!: string;

  @IsOptional()
  @IsString()
  public readonly description?: string;
}
