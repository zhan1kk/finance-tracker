import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateAccountDTO } from './create-account.dto';

// Balance is derived from transactions, so it cannot be edited directly.
export class UpdateAccountDTO extends PartialType(
  OmitType(CreateAccountDTO, ['initialBalance'] as const),
) {}
