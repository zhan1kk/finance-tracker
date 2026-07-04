import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateTransactionDTO } from './create-transaction.dto';

// Not updatable:
// - accountId: the balance math only adjusts the original account
// - type / counterAccountId / parentTransactionId: delete and recreate instead
//   of mutating the transaction's nature
export class UpdateTransactionDTO extends PartialType(
  OmitType(CreateTransactionDTO, [
    'accountId',
    'type',
    'counterAccountId',
    'parentTransactionId',
  ] as const),
) {}
