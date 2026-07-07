import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicCategorizationProvider } from './categorization/anthropic.provider';
import { CategorizationService } from './categorization/categorization.service';
import { HeuristicCategorizationProvider } from './categorization/heuristic.provider';
import { CsvParserService } from './csv-parser.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { MappingService } from './mapping.service';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import {
  CATEGORIZATION_PROVIDER,
  type CategorizationProvider,
} from './types/import.types';

@Module({
  controllers: [ImportController, RulesController],
  providers: [
    ImportService,
    CsvParserService,
    MappingService,
    RulesService,
    CategorizationService,
    {
      provide: CATEGORIZATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CategorizationProvider => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        if (apiKey) {
          const model =
            config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5';
          return new AnthropicCategorizationProvider(apiKey, model);
        }
        return new HeuristicCategorizationProvider();
      },
    },
  ],
})
export class ImportsModule {}
