/**
 * Shared prompt + schema for extracting transactions from raw PDF statement
 * text with a local Ollama model. Deliberately separate from the categorization
 * prompt: this stage only pulls out {date, amount, description}; categorization
 * and dedup happen afterwards in the normal import pipeline.
 */

export type ExtractedTransaction = {
  date: string;
  amount: number;
  description: string;
};

/** Ollama structured-output schema: a flat list of transactions. */
export const PDF_EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    transactions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          date: { type: 'string' as const },
          amount: { type: 'number' as const },
          description: { type: 'string' as const },
        },
        required: ['date', 'amount', 'description'],
      },
    },
  },
  required: ['transactions'],
};

export const PDF_EXTRACTION_SYSTEM_PROMPT = `You extract financial transactions from the raw text of a bank or credit-card statement.
Return ONLY JSON matching the schema — a "transactions" array.

Rules:
- One object per real transaction. Ignore headers, footers, page numbers, running balances, subtotals, totals, and interest/summary lines.
- date: the transaction (booking) date as "YYYY-MM-DD". If a row omits the year, infer it from the statement period.
- amount: a signed decimal number in the ACCOUNT'S OWN CURRENCY, named above. Money LEAVING the account (purchases, payments, debits, fees, withdrawals) is NEGATIVE; money ARRIVING (credits, refunds, incoming transfers) is POSITIVE.
- Some statements print a second, converted amount beside the real one, usually in brackets — e.g. "9 000,00 ₸ (15,00 €)" on a tenge account. Always take the amount in the account's currency and ignore the bracketed conversion. Never mix the two.
- description: the merchant or counterparty plus any useful detail, on one line.
- Do not invent transactions and do not drop real ones. If a value is unclear, use your best reading of the text.`;

export function buildPdfExtractionPrompt(
  text: string,
  currency?: string,
): string {
  // Naming the account's currency is what lets the model resolve a line that
  // shows two amounts; without it, "the statement's currency" is a guess.
  const header = currency
    ? `This statement belongs to an account denominated in ${currency}. Every amount you return must be in ${currency}.\n\n`
    : '';
  return `${header}Statement text:\n\n${text}\n\nExtract every transaction as JSON.`;
}

/**
 * How many transactions go into one extraction request.
 *
 * The model has to *write out* every transaction it finds, so the reply grows
 * with the statement while the timeout does not. Measured on the 4-CPU server:
 * a transaction costs about 45 output tokens, and generation runs at 6.6
 * tokens/s on qwen2.5:7b, 9.3 on qwen3:4b. A whole Vivid month asked for at
 * once was cut off mid-JSON after 180s and the import failed with nothing to
 * show for three minutes of work.
 *
 * Ten transactions is ~450 tokens: about 70s on the slower model, comfortably
 * inside the per-request timeout. A first attempt budgeted by character count
 * instead, and 2500 characters turned out to be thirty-odd transactions of a
 * densely printed statement — it timed out exactly as before. Count what the
 * model has to write, not how much it has to read.
 */
const MAX_TRANSACTIONS_PER_CHUNK = 10;
/** Secondary guard, for a statement that prints each entry over several lines. */
const CHUNK_CHARS = 2500;

/** A line that opens a transaction — a date in any of the usual layouts. */
const DATE_LINE =
  /(\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b)|(\b\d{4}-\d{2}-\d{2}\b)|(\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}\b)/i;
/** Enough header for the statement period, without pulling in the table. */
const MAX_HEADER_LINES = 12;

/**
 * Splits statement text into a shared header plus body chunks, so extraction
 * can be asked for ten transactions at a time instead of all of them.
 *
 * The header is whatever precedes the first dated line — the bank's name, the
 * account, the statement period. It is repeated in every chunk because the
 * prompt asks the model to infer a missing year from the period, which only
 * chunk one would otherwise have.
 *
 * Chunks are only ever cut immediately before a dated line, so an entry printed
 * across several lines stays whole; and they never overlap, so no transaction is
 * offered twice. Both matter downstream: two genuinely identical charges on one
 * day are real, so the merged result cannot be de-duplicated to clean up after a
 * sloppy split.
 */
export function splitStatementText(text: string): {
  header: string;
  chunks: string[];
} {
  const lines = text.split('\n');
  const firstDated = lines.findIndex((l) => DATE_LINE.test(l));
  const headerEnd =
    firstDated === -1 ? 0 : Math.min(firstDated, MAX_HEADER_LINES);
  const header = lines.slice(0, headerEnd).join('\n').trim();

  const chunks: string[] = [];
  let current: string[] = [];
  let dated = 0;
  let size = 0;
  for (const line of lines.slice(headerEnd)) {
    const startsTransaction = DATE_LINE.test(line);
    if (
      startsTransaction &&
      current.length > 0 &&
      (dated >= MAX_TRANSACTIONS_PER_CHUNK || size >= CHUNK_CHARS)
    ) {
      chunks.push(current.join('\n'));
      current = [];
      dated = 0;
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
    if (startsTransaction) dated += 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  return { header, chunks: chunks.filter((c) => c.trim().length > 0) };
}

/**
 * Validates the model's output into clean rows, dropping anything unusable
 * (missing date, non-numeric or zero amount). Downstream parsing/dedup/review
 * still apply, so this only needs to guard against obviously broken items.
 */
export function coerceExtractedTransactions(
  raw: unknown,
): ExtractedTransaction[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedTransaction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const date = typeof r.date === 'string' ? r.date.trim() : '';
    const description =
      typeof r.description === 'string' ? r.description.trim() : '';
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    if (!date || !Number.isFinite(amount) || amount === 0) continue;
    out.push({ date, amount, description: description || 'Transaction' });
  }
  return out;
}
