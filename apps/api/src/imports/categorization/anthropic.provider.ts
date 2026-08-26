import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type {
  CategorizationInput,
  CategorizationPrediction,
  CategorizationProvider,
  SubcategoryLite,
} from '../types/import.types';
import {
  aliasSubcategories,
  buildCategorizationPrompt,
  CATEGORIZATION_RESPONSE_SCHEMA,
  CATEGORIZATION_SYSTEM_PROMPT,
  coercePredictions,
} from './prompt';

const CHUNK_SIZE = 40;
const MAX_TOKENS = 8192;

/**
 * Hosted LLM categorizer (Claude). Selected when CATEGORIZER=anthropic, or by
 * default when an ANTHROPIC_API_KEY is present. Uses tool-use for structured
 * output and chunks large imports. Any API/parse failure yields null
 * predictions for that chunk (the rows fall to manual review) — an import must
 * never fail because the model is unavailable.
 */
export class AnthropicCategorizationProvider implements CategorizationProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicCategorizationProvider.name);
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): Promise<CategorizationPrediction[]> {
    const allowedIds = new Set(subcategories.map((s) => s.id));
    // Chunks are independent, so they run in parallel: a month's statement is
    // one round-trip of wall time instead of several in sequence (the import
    // request is synchronous — the browser is waiting on it). categorizeChunk
    // never rejects, so one failed chunk cannot sink the others.
    const chunks: CategorizationInput[][] = [];
    for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
      chunks.push(inputs.slice(i, i + CHUNK_SIZE));
    }
    const results = await Promise.all(
      chunks.map((chunk) =>
        this.categorizeChunk(chunk, subcategories, allowedIds),
      ),
    );
    return results.flat();
  }

  private async categorizeChunk(
    chunk: CategorizationInput[],
    subcategories: SubcategoryLite[],
    allowedIds: Set<string>,
  ): Promise<CategorizationPrediction[]> {
    const fallback = chunk.map((c) => ({
      rowId: c.rowId,
      subcategoryId: null,
      confidence: 0,
    }));

    // Row ids are aliased to their chunk index for the round trip: echoing the
    // real 64-char hash ids roughly tripled the reply, which could push a full
    // chunk past the token budget and silently truncate the JSON — losing every
    // prediction in the chunk at once.
    const aliased = chunk.map((c, i) => ({ ...c, rowId: String(i + 1) }));
    // Category ids are aliased too, so both providers are held to the same
    // prompt and the local-vs-hosted comparison stays honest.
    const { aliased: aliasedSubs, realIdFor } =
      aliasSubcategories(subcategories);

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: CATEGORIZATION_SYSTEM_PROMPT,
        tools: [
          {
            name: 'submit_categorizations',
            description: 'Return a categorization for every transaction.',
            input_schema: CATEGORIZATION_RESPONSE_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'submit_categorizations' },
        messages: [
          {
            role: 'user',
            content: buildCategorizationPrompt(aliased, aliasedSubs),
          },
        ],
      });

      if (message.stop_reason === 'max_tokens') {
        // Truncated tool input parses as missing/partial items; affected rows
        // fall back to review. Log it so a silent quality drop is explainable.
        this.logger.warn(
          `Categorization reply truncated at ${MAX_TOKENS} tokens for a ${chunk.length}-row chunk`,
        );
      }

      const block = message.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') return fallback;

      const items = (block.input as { items?: unknown }).items;
      // Predictions come back in aliased-chunk order; restore the real row ids.
      return coercePredictions(items, aliased, allowedIds, realIdFor).map(
        (p, i) => ({
          ...p,
          rowId: chunk[i].rowId,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Anthropic categorization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  }
}
