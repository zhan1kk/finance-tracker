import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import type { AccountType } from '../types/account.types';

const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'credit',
  'investment',
  'crypto',
] as const;

export class CreateAccountDTO {
  @IsString()
  @IsNotEmpty()
  public readonly name!: string;

  @IsIn(ACCOUNT_TYPES)
  public readonly type!: AccountType;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  public readonly currency!: string;

  /** Starting balance in minor currency units (cents). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly initialBalance?: number;
}
