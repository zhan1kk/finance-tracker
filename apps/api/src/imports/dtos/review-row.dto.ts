import { IsUUID } from 'class-validator';

export class ReviewRowDTO {
  /** The corrected subcategory for this row. */
  @IsUUID()
  public readonly subcategoryId!: string;
}
