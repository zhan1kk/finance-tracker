import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CATEGORIZER_IDS,
  type CategorizerId,
} from '../categorization/categorizer.factory';

export class CreatePdfImportDTO {
  @IsUUID()
  public readonly accountId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public readonly filename!: string;

  /** Base64-encoded PDF contents (no data: prefix). */
  @IsString()
  @MinLength(1)
  public readonly pdfBase64!: string;

  /** Applies to the categorization that follows extraction, not to reading the
   *  PDF: that is always local. Omitted means the server default. */
  @IsOptional()
  @IsIn(CATEGORIZER_IDS)
  public readonly categorizer?: CategorizerId;
  /** Model to run this import on, overriding the server's configured one. What
   *  makes two local models comparable without an .env edit and a restart
   *  between runs. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly categorizerModel?: string;
}
