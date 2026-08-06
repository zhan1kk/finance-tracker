import { IsString, Matches } from 'class-validator';

export class SyncRateDTO {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  public readonly currency!: string;
}
