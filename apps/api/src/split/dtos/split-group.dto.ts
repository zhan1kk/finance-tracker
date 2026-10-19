import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateSplitGroupDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public readonly name!: string;

  /** Friends to start with; more are added as they appear in expenses. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  public readonly memberIds?: string[];
}

export class RenameSplitGroupDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public readonly name!: string;
}

export class AddGroupMemberDTO {
  @IsUUID()
  public readonly friendId!: string;
}

/** Moves an expense or a settlement into a group, or out of one with null. */
export class MoveToGroupDTO {
  @ValidateIf((o: MoveToGroupDTO) => o.groupId !== null)
  @IsUUID()
  public readonly groupId!: string | null;
}

/**
 * Which part of the ledger a list or the balances cover: one group by id,
 * "none" for what is not in any group, or — when absent — everything.
 */
export class SplitScopeQuery {
  @IsOptional()
  @ValidateIf((o: SplitScopeQuery) => o.group !== 'none')
  @IsUUID()
  public readonly group?: string;
}
