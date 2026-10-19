import Anthropic from '@anthropic-ai/sdk';
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
 * Errors propagate so the caller can report which part of the statement failed,
 * and that includes a reply that came back incomplete.
 */
export class AnthropicPdfExtractor {
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

    // Both of these fail the import, the way a cut-off local reply does. A
    // truncated reply is partial JSON: some transactions in this part are
    // simply gone, and nothing downstream can tell that from a statement that
    // really had fewer rows. Keeping what did come back would look like a
    // complete statement, and there is no review step that would show the gap.
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `the reply was cut off at ${MAX_TOKENS} tokens, so some rows in this part would be missing. Lower ANTHROPIC_CHUNK_TRANSACTIONS.`,
      );
    }
    // The tool is forced, so even a part with no transactions comes back as a
    // call with an empty list. No call at all means the part went unread.
    const block = message.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error(
        `the reply had no transactions in it (stop reason: ${message.stop_reason ?? 'none'})`,
      );
    }

    const { transactions } = block.input as { transactions?: unknown };
    return coerceExtractedTransactions(transactions);
  }
}
