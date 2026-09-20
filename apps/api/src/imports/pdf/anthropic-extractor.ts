import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  buildPdfExtractionPrompt,
  coerceExtractedTransactions,
  type ExtractedTransaction,
  PDF_EXTRACTION_SCHEMA,
  PDF_EXTRACTION_SYSTEM_PROMPT,
} from './pdf-prompt';

/**
 * Chunk size for the hosted reader.
 *
 * The local path sends five transactions at a time because a CPU model writes
 * roughly seven tokens a second and a longer reply walks into the timeout. None
 * of that applies here, and the statement header is re-sent with every chunk,
 * so a small chunk costs real tokens for nothing: a forty-transaction statement
 * split five at a time pays for the header eight times. Forty matches the
 * categorizer, which settled on the same number against the same reply budget.
 */
export const ANTHROPIC_CHUNK_TRANSACTIONS = 40;
/** Secondary guard, for a statement that prints each entry at length. */
export const ANTHROPIC_CHUNK_CHARS = 24_000;

const MAX_TOKENS = 8192;

/**
 * Reads statement text with Claude instead of a local Ollama model.
 *
 * Structured output comes from tool-use, the same mechanism the Anthropic
 * categorizer uses, rather than Ollama's `format` schema — the JSON Schema
 * itself is shared, so both readers are held to one contract.
 *
 * Unlike categorization, a failure here is fatal to the import rather than
 * something that falls back to manual review: there are no rows yet to review.
 * Errors propagate so the caller can report which part of the statement failed.
 */
export class AnthropicPdfExtractor {
  private readonly logger = new Logger(AnthropicPdfExtractor.name);
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async extractChunk(
    text: string,
    currency?: string,
  ): Promise<ExtractedTransaction[]> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: PDF_EXTRACTION_SYSTEM_PROMPT,
      tools: [
        {
          name: 'submit_transactions',
          description: 'Return every transaction found in the statement text.',
          input_schema: PDF_EXTRACTION_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_transactions' },
      messages: [
        { role: 'user', content: buildPdfExtractionPrompt(text, currency) },
      ],
    });

    if (message.stop_reason === 'max_tokens') {
      // A truncated reply is partial JSON: some transactions in this chunk are
      // simply gone, and nothing downstream can tell that from a statement that
      // really had fewer rows. Louder than the categorizer's equivalent warning
      // because there is no review step that would surface the gap.
      this.logger.warn(
        `PDF extraction reply truncated at ${MAX_TOKENS} tokens — rows in this part of the statement were lost. Lower ANTHROPIC_CHUNK_TRANSACTIONS.`,
      );
    }

    const block = message.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return [];

    const { transactions } = block.input as { transactions?: unknown };
    return coerceExtractedTransactions(transactions);
  }
}
