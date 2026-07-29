import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSubcategoryDTO } from './create-subcategory.dto';

export class UpdateSubcategoryDTO extends PartialType(CreateSubcategoryDTO) {
  /** Show as a one-tap shortcut in the Telegram capture picker. */
  @IsOptional()
  @IsBoolean()
  public readonly pinned?: boolean;
}
