import { PartialType } from '@nestjs/swagger';
import { CreateAccountDTO } from './create-account.dto';

// Balance itself stays derived (initialBalance + transactions), but the
// starting balance may be corrected — the service shifts balance by the same
// difference so history is preserved.
export class UpdateAccountDTO extends PartialType(CreateAccountDTO) {}
