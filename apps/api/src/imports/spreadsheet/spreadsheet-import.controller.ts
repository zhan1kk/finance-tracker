import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/types/auth.types';
import {
  ApplySpreadsheetDTO,
  PreviewSpreadsheetDTO,
} from './dtos/spreadsheet.dto';
import { SpreadsheetImportService } from './spreadsheet-import.service';

@Controller('imports/spreadsheet')
export class SpreadsheetImportController {
  constructor(private readonly spreadsheet: SpreadsheetImportService) {}

  /** Proposes subcategories + budgets from a workbook. Writes nothing. */
  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() body: PreviewSpreadsheetDTO) {
    return this.spreadsheet.preview(user.userId, body.file);
  }

  /** Creates the subcategories and budgets the user confirmed. */
  @Post('apply')
  apply(@CurrentUser() user: AuthUser, @Body() body: ApplySpreadsheetDTO) {
    return this.spreadsheet.apply(user.userId, body.items);
  }
}
