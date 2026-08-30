import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSubcategoryDTO } from './create-subcategory.dto';

export class UpdateSubcategoryDTO extends PartialType(CreateSubcategoryDTO) {
  /** Show as a one-tap shortcut in the Telegram capture picker. */
  @IsOptional()
  @IsBoolean()
  public readonly pinned?: boolean;

  /** Retire (true) or bring back (false). A retired category keeps everything
   *  it already holds; it is just no longer offered for anything new. */
  @IsOptional()
  @IsBoolean()
  public readonly archived?: boolean;
}
