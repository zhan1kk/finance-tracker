import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { ColumnMappingDTO } from './dtos/column-mapping.dto';
import { CreateImportDTO } from './dtos/create-import.dto';
import { InspectCsvDTO } from './dtos/inspect-csv.dto';
import { ReviewRowDTO } from './dtos/review-row.dto';
import { ImportService } from './import.service';
import { MappingService } from './mapping.service';

@Controller('imports')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly mappingService: MappingService,
  ) {}

  /** Detect headers + sample rows for building a column mapping. */
  @Post('inspect')
  inspect(@CurrentUser() user: AuthUser, @Body() body: InspectCsvDTO) {
    return this.importService.inspect(body.csv, body.hasHeader);
  }

  @Post()
  createImport(@CurrentUser() user: AuthUser, @Body() body: CreateImportDTO) {
    return this.importService.createImport(user.userId, body);
  }

  @Get()
  listBatches(@CurrentUser() user: AuthUser) {
    return this.importService.listBatches(user.userId);
  }

  @Get('stats/accuracy')
  accuracyStats(@CurrentUser() user: AuthUser) {
    return this.importService.accuracyStats(user.userId);
  }

  @Get('mapping/:accountId')
  getMapping(
    @CurrentUser() user: AuthUser,
    @Param('accountId') accountId: string,
  ) {
    return this.mappingService.get(user.userId, accountId);
  }

  @Put('mapping/:accountId')
  putMapping(
    @CurrentUser() user: AuthUser,
    @Param('accountId') accountId: string,
    @Body() body: ColumnMappingDTO,
  ) {
    return this.mappingService.upsert(user.userId, accountId, body);
  }

  @Get(':id')
  getBatch(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.getBatch(user.userId, id);
  }

  @Patch(':id/rows/:rowId')
  reviewRow(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() body: ReviewRowDTO,
  ) {
    return this.importService.reviewRow(
      user.userId,
      id,
      rowId,
      body.subcategoryId,
    );
  }

  @Post(':id/commit')
  commit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.commit(user.userId, id);
  }

  @Post(':id/undo')
  undo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.undo(user.userId, id);
  }

  @Delete(':id')
  discard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.discard(user.userId, id);
  }
}
