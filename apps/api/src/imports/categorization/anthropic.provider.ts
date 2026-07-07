import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type {
  CategorizationInput,
  CategorizationPrediction,
  CategorizationProvider,
  SubcategoryLite,
} from '../types/import.types';

const CHUNK_SIZE = 40;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  "You categorize bank/card transactions into a fixed list of the user's " +
  'subcategories. For each transaction, choose the single best subcategory id ' +
  'from the provided list, or null if none is a reasonable fit. Also return a ' +
  'confidence between 0 and 1 reflecting how certain you are. Prefer null with ' +
  'low confidence over a wrong guess. Use only ids from the list.';

/**
 * LLM categorizer. Selected only when ANTHROPIC_API_KEY is set. Uses tool-use
 * for structured output and chunks large imports. Any API/parse failure yields
 * null predictions for that chunk (the rows fall to manual review) — an import
 * must never fail because the model is unavailable.
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
    const results: CategorizationPrediction[] = [];
    for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
      const chunk = inputs.slice(i, i + CHUNK_SIZE);
      results.push(
        ...(await this.categorizeChunk(chunk, subcategories, allowedIds)),
      );
    }
    return results;
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

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: 'submit_categorizations',
            description: 'Return a categorization for every transaction.',
            input_schema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      rowId: { type: 'string' },
                      subcategoryId: { type: ['string', 'null'] },
                      confidence: { type: 'number' },
                    },
                    required: ['rowId', 'subcategoryId', 'confidence'],
                  },
                },
              },
              required: ['items'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'submit_categorizations' },
        messages: [
          {
            role: 'user',
            content: this.buildPrompt(chunk, subcategories),
          },
        ],
      });

      const block = message.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') return fallback;

      const items = (block.input as { items?: unknown }).items;
      if (!Array.isArray(items)) return fallback;

      const byRow = new Map<string, CategorizationPrediction>();
      for (const item of items as Record<string, unknown>[]) {
        const rowId = typeof item.rowId === 'string' ? item.rowId : null;
        if (!rowId) continue;
        const rawId = item.subcategoryId;
        const subcategoryId =
          typeof rawId === 'string' && allowedIds.has(rawId) ? rawId : null;
        const confidence =
          typeof item.confidence === 'number'
            ? Math.max(0, Math.min(1, item.confidence))
            : 0;
        byRow.set(rowId, { rowId, subcategoryId, confidence });
      }
      return chunk.map(
        (c) =>
          byRow.get(c.rowId) ?? {
            rowId: c.rowId,
            subcategoryId: null,
            confidence: 0,
          },
      );
    } catch (err) {
      this.logger.error(
        `Anthropic categorization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  }

  private buildPrompt(
    chunk: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): string {
    const cats = subcategories
      .map((s) => `- ${s.id} — ${s.name} (${s.category})`)
      .join('\n');
    const rows = chunk
      .map(
        (c) =>
          `- rowId ${c.rowId}: ${c.type} ${(c.amount / 100).toFixed(2)} — "${c.description}"`,
      )
      .join('\n');
    return `Subcategories:\n${cats}\n\nTransactions:\n${rows}`;
  }
}
