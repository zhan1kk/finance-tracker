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
 * What went wrong with a Claude call, in words for the review screen. The raw
 * SDK message is a status code and a JSON body; this names the cause and so
 * the fix. Never includes the key: Anthropic's errors do not echo it.
 */
export function explainAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return 'Claude did not answer in time';
  if (err instanceof Anthropic.APIConnectionError)
    return 'this server could not reach Claude';
  if (err instanceof Anthropic.AuthenticationError)
    return 'the API key was rejected';
  if (err instanceof Anthropic.PermissionDeniedError)
    return 'the API key is not allowed to use this model';
  if (err instanceof Anthropic.NotFoundError)
    return 'the model name was not recognised';
  if (err instanceof Anthropic.RateLimitError)
    return 'Claude is rate-limiting this key, try again in a minute';
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: unknown } } | undefined;
    const detail =
      typeof body?.error?.message === 'string' ? body.error.message : '';
    if (/credit balance/i.test(detail))
      return 'the Anthropic account is out of credit';
    if (err.status !== undefined && err.status >= 500)
      return 'Claude is having problems right now, try again later';
    return (detail || err.message).slice(0, 200);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Hosted LLM categorizer (Claude). Selected when CATEGORIZER=anthropic, or by
 * default when an ANTHROPIC_API_KEY is present. Uses tool-use for structured
 * output and chunks large imports. Any API/parse failure yields null
 * predictions for that chunk (the rows fall to manual review) — an import must
 * never fail because the model is unavailable. Those predictions carry the
 * reason, so the review screen can say Claude did not run instead of
 * claiming it categorized the batch.
 */
export class AnthropicCategorizationProvider implements CategorizationProvider {
  readonly name = 'anthropic';

  get modelName(): string {
    return this.model;
  }
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
    const fallback = (error: string): CategorizationPrediction[] =>
      chunk.map((c) => ({
        rowId: c.rowId,
        subcategoryId: null,
        confidence: 0,
        error,
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
      if (!block || block.type !== 'tool_use') {
        return fallback(
          `Claude's reply had no categories in it (stop reason: ${message.stop_reason ?? 'none'})`,
        );
      }

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
      return fallback(explainAnthropicError(err));
    }
  }
}
