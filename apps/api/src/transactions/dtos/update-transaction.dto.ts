import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateTransactionDTO } from './create-transaction.dto';

// Moving a transaction between accounts is not supported (the balance math
// only adjusts the original account), so accountId is not updatable.
export class UpdateTransactionDTO extends PartialType(
  OmitType(CreateTransactionDTO, ['accountId'] as const),
) {}
