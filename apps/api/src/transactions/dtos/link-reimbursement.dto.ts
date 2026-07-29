import { IsUUID, ValidateIf } from 'class-validator';

/** Links an existing INCOME to the EXPENSE it reimburses, or unlinks (null). */
export class LinkReimbursementDTO {
  // null unlinks; a UUID links. ValidateIf lets null through while still
  // rejecting a missing field or a non-UUID string.
  @ValidateIf((o: LinkReimbursementDTO) => o.parentTransactionId !== null)
  @IsUUID()
  public readonly parentTransactionId!: string | null;
}
