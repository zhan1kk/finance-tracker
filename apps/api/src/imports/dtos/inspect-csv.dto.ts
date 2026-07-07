import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class InspectCsvDTO {
  @IsString()
  @MinLength(1)
  public readonly csv!: string;

  @IsOptional()
  @IsBoolean()
  public readonly hasHeader?: boolean;
}
