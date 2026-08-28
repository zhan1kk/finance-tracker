import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { CategorizationService } from './categorization/categorization.service';
import { CategorizerFactory } from './categorization/categorizer.factory';
import { CsvParserService } from './csv-parser.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { MappingService } from './mapping.service';
import { PdfImportService } from './pdf/pdf-import.service';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import {
  CATEGORIZATION_PROVIDER,
  type CategorizationProvider,
} from './types/import.types';

@Module({
  imports: [JobsModule],
  controllers: [ImportController, RulesController],
  providers: [
    ImportService,
    CsvParserService,
    MappingService,
    RulesService,
    CategorizationService,
    CategorizerFactory,
    PdfImportService,
    {
      // The server default, resolved once at boot. An import that names a
      // provider gets one built per request by the factory instead.
      provide: CATEGORIZATION_PROVIDER,
      inject: [CategorizerFactory],
      useFactory: (factory: CategorizerFactory): CategorizationProvider =>
        factory.create(),
    },
  ],
})
export class ImportsModule {}
