import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

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
}
