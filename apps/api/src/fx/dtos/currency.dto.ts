import { IsBoolean, IsString, Length, Matches } from 'class-validator';

export class AddCurrencyDTO {
  /** Three-letter code; whether it really exists is proven by fetching a rate. */
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency must be a three-letter code, e.g. USD',
  })
  public readonly currency!: string;
}

export class SetAutoSyncDTO {
  @IsBoolean()
  public readonly autoSync!: boolean;
}
