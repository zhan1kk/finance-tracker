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
import { JobsService } from '../jobs/jobs.service';
import { ColumnMappingDTO } from './dtos/column-mapping.dto';
import { CreateImportDTO } from './dtos/create-import.dto';
import { CreatePdfImportDTO } from './dtos/create-pdf-import.dto';
import { InspectCsvDTO } from './dtos/inspect-csv.dto';
import { ReviewRowDTO } from './dtos/review-row.dto';
import { SkipRowDTO } from './dtos/skip-row.dto';
import { CategorizationService } from './categorization/categorization.service';
import { ImportService } from './import.service';
import { MappingService } from './mapping.service';
import { PdfImportService } from './pdf/pdf-import.service';

@Controller('imports')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly mappingService: MappingService,
    private readonly pdfImportService: PdfImportService,
    private readonly jobs: JobsService,
    private readonly categorization: CategorizationService,
  ) {}

  /** Detect headers + sample rows for building a column mapping. */
  @Post('inspect')
  inspect(@CurrentUser() user: AuthUser, @Body() body: InspectCsvDTO) {
    return this.importService.inspect(body.csv, body.hasHeader);
  }

  /**
   * Stages and categorizes a CSV, in the background, returning a job id to poll.
   *
   * It used to hold the connection open for the whole categorization. With a
   * local model that is minutes, and the work only existed as an in-flight
   * request — the batch row is not written until categorization finishes — so
   * navigating away or restarting the API lost the run with no record that it
   * had ever been attempted. The PDF route has always worked this way; now both
   * do, and the work runs to completion server-side whether anyone is listening
   * or not.
   */
  @Post()
  createImport(@CurrentUser() user: AuthUser, @Body() body: CreateImportDTO) {
    const jobId = this.jobs.start(user.userId, () =>
      this.importService.createImport(user.userId, body),
    );
    return { jobId };
  }

  /**
   * Extract a PDF statement (local Ollama) into a review batch. Runs in the
   * background — returns a job id to poll, since extraction can take a minute.
   */
  @Post('pdf')
  importPdf(@CurrentUser() user: AuthUser, @Body() body: CreatePdfImportDTO) {
    const jobId = this.jobs.start(user.userId, () =>
      this.pdfImportService.importPdf(user.userId, body),
    );
    return { jobId };
  }

  @Get()
  listBatches(@CurrentUser() user: AuthUser) {
    return this.importService.listBatches(user.userId);
  }

  /** Which categorizers this server can run, so the import screen can offer a
   *  choice instead of hiding the decision in an environment variable. */
  @Get('categorizers')
  categorizers() {
    return this.categorization.options();
  }

  /** Models the local Ollama has pulled, for the per-run model picker. */
  @Get('ollama-models')
  ollamaModels() {
    return this.categorization.installedOllamaModels();
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

  /** Everything measurable about one run, before or after committing it. */
  @Get(':id/benchmark')
  benchmark(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.batchBenchmark(user.userId, id);
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
    return this.importService.reviewRow(user.userId, id, rowId, body);
  }

  /** Flip a row between income and expense (for statements with inverted signs). */
  @Post(':id/rows/:rowId/flip')
  flipRow(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
  ) {
    return this.importService.flipRowDirection(user.userId, id, rowId);
  }

  /** Drop a row from the import, or restore it (a duplicate dedup can't catch). */
  @Post(':id/rows/:rowId/skip')
  skipRow(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() body: SkipRowDTO,
  ) {
    return this.importService.setRowSkipped(
      user.userId,
      id,
      rowId,
      body.skipped,
    );
  }

  /** Force-include a row flagged as a duplicate ("import anyway"). */
  @Post(':id/rows/:rowId/include')
  includeRow(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
  ) {
    return this.importService.overrideDuplicate(user.userId, id, rowId);
  }

  @Post(':id/commit')
  commit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.commit(user.userId, id);
  }

  @Post(':id/undo')
  undo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.undo(user.userId, id);
  }

  @Post(':id/reopen')
  reopen(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.reopen(user.userId, id);
  }

  @Delete(':id')
  discard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.importService.discard(user.userId, id);
  }
}
