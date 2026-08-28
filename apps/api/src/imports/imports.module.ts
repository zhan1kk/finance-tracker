import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../common/env';
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
        const logger = new Logger('CategorizationProvider');
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        const configured = (config.get<string>('CATEGORIZER') ?? '')
          .trim()
          .toLowerCase();
        // Explicit CATEGORIZER wins (lets the thesis swap providers to compare
        // accuracy); otherwise default to Anthropic-if-key-present, else the
        // zero-config heuristic. An unrecognized value falls through to safe.
        const selected = configured || (apiKey ? 'anthropic' : 'heuristic');

        // The choice is logged at boot because staying quiet about it cost a
        // month: .env said CATEGORIZER=ollama, docker-compose did not pass the
        // variable through, and the blank value resolved back to Anthropic
        // because a key happened to be present. Eleven real imports ran on the
        // hosted model while the deployment was believed to be local, and
        // nothing anywhere said otherwise. Inferring a provider is fine;
        // inferring one without a line in the log is not.
        if (!configured) {
          logger.warn(
            `CATEGORIZER is not set — inferred "${selected}" from the environment`,
          );
        }

        if (selected === 'anthropic') {
          if (!apiKey) {
            throw new Error(
              'CATEGORIZER=anthropic requires ANTHROPIC_API_KEY to be set',
            );
          }
          // optionalSetting, not `??`: compose passes this as
          // ${ANTHROPIC_MODEL:-}, so unset arrives as "" and would
          // sail past a nullish check straight into the API as an
          // empty model name.
          const model =
            optionalSetting(config, 'ANTHROPIC_MODEL') ?? 'claude-sonnet-5';
          logger.log(
            `Categorizing imports with Anthropic ${model} — row descriptions and amounts leave this machine`,
          );
          return new AnthropicCategorizationProvider(apiKey, model);
        }
        if (selected === 'ollama') {
          const baseUrl =
            config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
          const model = config.get<string>('OLLAMA_MODEL') ?? 'llama3.1';
          logger.log(
            `Categorizing imports with Ollama ${model} at ${baseUrl} — nothing leaves this machine`,
          );
          return new OllamaCategorizationProvider(baseUrl, model);
        }
        if (selected !== 'heuristic') {
          logger.warn(
            `Unrecognized CATEGORIZER="${configured}" — using the heuristic categorizer`,
          );
        } else {
          logger.log('Categorizing imports with the built-in heuristic');
        }
        return new HeuristicCategorizationProvider();
      },
    },
  ],
})
export class ImportsModule {}
