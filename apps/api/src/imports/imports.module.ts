import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsModule } from '../jobs/jobs.module';
import { AnthropicCategorizationProvider } from './categorization/anthropic.provider';
import { CategorizationService } from './categorization/categorization.service';
import { HeuristicCategorizationProvider } from './categorization/heuristic.provider';
import { OllamaCategorizationProvider } from './categorization/ollama.provider';
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
    PdfImportService,
    {
      provide: CATEGORIZATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CategorizationProvider => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        // Explicit CATEGORIZER wins (lets the thesis swap providers to compare
        // accuracy); otherwise default to Anthropic-if-key-present, else the
        // zero-config heuristic. An unrecognized value falls through to safe.
        const selected =
          (config.get<string>('CATEGORIZER') ?? '').trim().toLowerCase() ||
          (apiKey ? 'anthropic' : 'heuristic');

        if (selected === 'anthropic') {
          if (!apiKey) {
            throw new Error(
              'CATEGORIZER=anthropic requires ANTHROPIC_API_KEY to be set',
            );
          }
          const model =
            config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5';
          return new AnthropicCategorizationProvider(apiKey, model);
        }
        if (selected === 'ollama') {
          const baseUrl =
            config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
          const model = config.get<string>('OLLAMA_MODEL') ?? 'llama3.1';
          return new OllamaCategorizationProvider(baseUrl, model);
        }
        return new HeuristicCategorizationProvider();
      },
    },
  ],
})
export class ImportsModule {}
