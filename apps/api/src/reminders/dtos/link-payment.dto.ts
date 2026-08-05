import { IsUUID } from 'class-validator';

export class LinkPaymentDTO {
  /** The INCOME transaction that settles this reminder. */
  @IsUUID()
  public readonly transactionId!: string;
}
