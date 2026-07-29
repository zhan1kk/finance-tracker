import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
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

  /** Starting balance in minor currency units (cents). Negative is allowed —
   * a credit card's opening state is the debt owed on day one. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  public readonly initialBalance?: number;

  /** Whether this account counts toward the base-currency net worth (default
   * true). Turn off for a foreign pocket you don't count as wealth. */
  @IsOptional()
  @IsBoolean()
  public readonly countInNetWorth?: boolean;

  /** Pins the account to the top of the list, separated from the rest. */
  @IsOptional()
  @IsBoolean()
  public readonly pinned?: boolean;
}
