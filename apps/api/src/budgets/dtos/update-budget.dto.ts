import { IsInt, Min } from 'class-validator';

export class UpdateBudgetDTO {
  @IsInt()
  @Min(1)
  public readonly monthlyLimit!: number;
}
