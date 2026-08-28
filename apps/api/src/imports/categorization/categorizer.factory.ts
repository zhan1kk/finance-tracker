import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../../common/env';
import type { CategorizationProvider } from '../types/import.types';
import { AnthropicCategorizationProvider } from './anthropic.provider';
import { HeuristicCategorizationProvider } from './heuristic.provider';
import { OllamaCategorizationProvider } from './ollama.provider';

export const CATEGORIZER_IDS = ['anthropic', 'ollama', 'heuristic'] as const;
export type CategorizerId = (typeof CATEGORIZER_IDS)[number];

export type CategorizerOption = {
  id: CategorizerId;
  label: string;
  /** The model behind it, when there is one. */
  model: string | null;
  /** Whether descriptions and amounts leave the server when this one runs. */
  sendsDataOffServer: boolean;
  /** False when the server cannot run it at all (Claude with no API key). */
  available: boolean;
  /** The one an import gets when it does not ask for a specific provider. */
  isDefault: boolean;
};

/**
 * Builds a categorization provider by name.
 *
 * This used to be an inline module factory, because the choice was made once at
 * boot. An import can now name the provider it wants, which is the only way to
 * compare two models on the same statement: import a file with one, undo, and
 * import it again with the other. The server default still applies to any
 * import that does not ask.
 */
@Injectable()
export class CategorizerFactory {
  private readonly logger = new Logger('CategorizationProvider');
  readonly defaultId: CategorizerId;

  constructor(private readonly config: ConfigService) {
    const configured = (
      optionalSetting(config, 'CATEGORIZER') ?? ''
    ).toLowerCase();
    // Explicit CATEGORIZER wins; otherwise Anthropic-if-key-present, else the
    // zero-config heuristic. An unrecognized value falls through to safe.
    const inferred: CategorizerId = this.apiKey ? 'anthropic' : 'heuristic';
    this.defaultId = isCategorizerId(configured) ? configured : inferred;

    // The choice is logged at boot because staying quiet about it cost a month:
    // .env said CATEGORIZER=ollama, docker-compose did not pass the variable
    // through, and the blank value resolved back to Anthropic because a key
    // happened to be present. Eleven real imports ran on the hosted model while
    // the deployment was believed to be local, and nothing anywhere said
    // otherwise. Inferring a provider is fine; inferring one silently is not.
    if (configured && !isCategorizerId(configured)) {
      this.logger.warn(
        `Unrecognized CATEGORIZER="${configured}" — using "${this.defaultId}"`,
      );
    } else if (!configured) {
      this.logger.warn(
        `CATEGORIZER is not set — inferred "${this.defaultId}" from the environment`,
      );
    }
    const def = this.options().find((o) => o.isDefault);
    this.logger.log(
      `Imports categorize with ${def?.label}${def?.model ? ` (${def.model})` : ''} unless one asks otherwise` +
        (def?.sendsDataOffServer
          ? ' — row descriptions and amounts leave this machine'
          : ' — nothing leaves this machine'),
    );
  }

  /** The provider for an import: the one it named, or the server default. */
  create(id?: string | null): CategorizationProvider {
    const wanted = id?.trim().toLowerCase();
    const chosen = isCategorizerId(wanted ?? '')
      ? (wanted as CategorizerId)
      : this.defaultId;

    if (chosen === 'anthropic') {
      const key = this.apiKey;
      if (!key) {
        // Reached two ways: a misconfigured CATEGORIZER=anthropic at boot
        // (where refusing to start is right), and a client asking for a
        // provider this server cannot run (where 400 is right).
        throw new BadRequestException(
          'Claude is not available: this server has no ANTHROPIC_API_KEY',
        );
      }
      return new AnthropicCategorizationProvider(key, this.anthropicModel);
    }
    if (chosen === 'ollama') {
      return new OllamaCategorizationProvider(
        optionalSetting(this.config, 'OLLAMA_BASE_URL') ??
          'http://localhost:11434',
        this.ollamaModel,
      );
    }
    return new HeuristicCategorizationProvider();
  }

  /** What this server can offer, for a UI to render as a choice. */
  options(): CategorizerOption[] {
    return [
      {
        id: 'anthropic',
        label: 'Claude',
        model: this.anthropicModel,
        sendsDataOffServer: true,
        available: Boolean(this.apiKey),
        isDefault: this.defaultId === 'anthropic',
      },
      {
        id: 'ollama',
        label: 'Local model',
        model: this.ollamaModel,
        sendsDataOffServer: false,
        available: true,
        isDefault: this.defaultId === 'ollama',
      },
      {
        id: 'heuristic',
        label: 'Keywords only',
        model: null,
        sendsDataOffServer: false,
        available: true,
        isDefault: this.defaultId === 'heuristic',
      },
    ];
  }

  private get apiKey(): string | undefined {
    return optionalSetting(this.config, 'ANTHROPIC_API_KEY');
  }

  private get anthropicModel(): string {
    return optionalSetting(this.config, 'ANTHROPIC_MODEL') ?? 'claude-sonnet-5';
  }

  private get ollamaModel(): string {
    return optionalSetting(this.config, 'OLLAMA_MODEL') ?? 'llama3.1';
  }
}

function isCategorizerId(value: string): value is CategorizerId {
  return (CATEGORIZER_IDS as readonly string[]).includes(value);
}
