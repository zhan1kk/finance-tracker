import { IsUUID } from 'class-validator';

export class UpdateRuleDTO {
  @IsUUID()
  public readonly subcategoryId!: string;
}
