import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateFriendDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  public readonly name!: string;
}
