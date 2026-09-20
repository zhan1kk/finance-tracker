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
 * tokens/s on qwen2.5:7b, 9.3 on qwen3:4b. A whole month asked for at once was
 * cut off mid-JSON after 180s, and a cut-off reply is not valid JSON — so the
 * import failed with nothing to show for three minutes of work.
 *
 * Five is both safer and, measured, faster. On a real 16-transaction Kaspi
 * statement with qwen3:4b, both sizes read all 16 correctly, but the smaller
 * chunks finished sooner — 96s against 124s — because attention cost grows
 * faster than the prompt does, so ten rows in one request costs more than the
 * same ten split in two. It matches what the categorizer measured
 * independently (see ollama.provider.ts), and it leaves the most headroom
 * against the timeout, which is the failure this whole path keeps hitting.
 */
const MAX_TRANSACTIONS_PER_CHUNK = 5;
/** Secondary guard, for a statement that prints each entry at length. */
const CHUNK_CHARS = 2500;
/** Used when nothing date-shaped is found at all, so a chunk is always bounded. */
const FALLBACK_CHUNK_CHARS = 2000;
/**
 * A statement prints a booking date and a value date side by side. Two matches
 * this close together are one entry's pair of dates, not two transactions.
 */
const MIN_ENTRY_CHARS = 25;
/**
 * Enough header for the statement period, without pulling in the table.
 *
 * A statement's preamble can be long — Kaspi's is a covering letter plus a
 * summary of totals — and all of it is re-read on every chunk, so it is capped.
 * Cut on a line boundary: the first attempt sliced 600 characters flat and
 * landed mid-sentence on "Balance statement for the period from | 28.07.26 to
 * 25.08.26", which left every chunk but the first with no period to read a
 * missing year from. One row came back dated to the letterhead instead.
 */
const MAX_HEADER_CHARS = 1500;

/**
 * Where a transaction entry begins.
 *
 * Anchored on digit boundaries rather than `\b`, because the text arrives with
 * the table's cells run together: in "...15,99 EUR01.08.2026 Metal plan..."
 * there is no word boundary before the date, and `\b\d` finds nothing at all.
 */
const DATE = String.raw`(?<!\d)(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?\d{2,4})(?!\d)`;
const ENTRY_START = new RegExp(DATE, 'gi');
/**
 * The same date, but only where a line opens with it.
 *
 * Preferred whenever a statement has line structure, because a transaction row
 * begins with its date while the noise around it merely contains one: "Card
 * balance 25.08.26 + 16 886,54 ₸", "Transfers - 34 760,00 ₸", "balance
 * statement for the period from 28.07.26 to 25.08.26". Counting those as
 * entries spent half of a chunk's budget on a summary table, so the chunk held
 * five real transactions and the next one held ten — and the overstuffed one
 * dropped a row and misdated another.
 */
const LINE_ENTRY_START = new RegExp(String.raw`^[^\S\r\n]*${DATE}`, 'gim');
/** Below this, line anchoring is more likely to be a coincidence than a layout. */
const MIN_LINE_ANCHORED = 3;

/** Trims the header to budget, keeping whole lines. */
function capHeader(header: string): string {
  const trimmed = header.trim();
  if (trimmed.length <= MAX_HEADER_CHARS) return trimmed;
  const lineBreak = trimmed.lastIndexOf('\n', MAX_HEADER_CHARS);
  return trimmed
    .slice(0, lineBreak > 0 ? lineBreak : MAX_HEADER_CHARS)
    .trimEnd();
}

/** Cuts oversized text at the last space inside the budget. */
function splitOnSize(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    const space = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = space > budget / 2 ? space : budget;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Splits statement text into a shared header plus body chunks, so extraction
 * can be asked for ten transactions at a time instead of all of them.
 *
 * Cuts land on dates found anywhere in the text, not on line breaks. pdf.js
 * only emits a newline where a text item happens to carry `hasEOL`, which for a
 * table layout is almost nowhere — a real Vivid statement arrives as one
 * continuous run, so a line-based split produced a single chunk and timed out
 * exactly as before the splitting existed.
 *
 * The header is whatever precedes the first date — the bank's name, the
 * account, the statement period. It is repeated in every chunk because the
 * prompt asks the model to infer a missing year from the period, which only
 * chunk one would otherwise have.
 *
 * Chunks never overlap, so no transaction is offered twice: two genuinely
 * identical charges on one day are real, so the merged result cannot be
 * de-duplicated afterwards to clean up a sloppy split.
 */
export function splitStatementText(
  text: string,
  limits: { maxTransactions?: number; maxChars?: number } = {},
): {
  header: string;
  chunks: string[];
} {
  // Both defaults are sized for a local model on CPU. A hosted model has no
  // such ceiling, and the header is re-sent with every chunk, so splitting
  // finely there is pure waste — it passes its own, much larger limits.
  const maxTransactions = limits.maxTransactions ?? MAX_TRANSACTIONS_PER_CHUNK;
  const maxChars = limits.maxChars ?? CHUNK_CHARS;
  // Where a statement has line structure, a date opening a line is a
  // transaction and a date buried in a line is prose. Text that arrives as one
  // run (pdf.js sets no line breaks for a table) has no line starts to prefer,
  // and falls back to dates wherever they appear.
  const lineAnchored = [...text.matchAll(LINE_ENTRY_START)];
  const matches =
    lineAnchored.length >= MIN_LINE_ANCHORED
      ? lineAnchored
      : [...text.matchAll(ENTRY_START)];

  const starts: number[] = [];
  for (const match of matches) {
    const at = match.index ?? 0;
    if (starts.length > 0 && at - starts[starts.length - 1] < MIN_ENTRY_CHARS) {
      continue;
    }
    starts.push(at);
  }

  // No date anywhere: there is likely nothing to extract, but the model still
  // has to read whatever this is, so bound it by size rather than sending it
  // whole and hoping.
  if (starts.length === 0) {
    return { header: '', chunks: splitOnSize(text, FALLBACK_CHUNK_CHARS) };
  }

  const header = capHeader(text.slice(0, starts[0]));

  const bounds = [...starts, text.length];
  const chunks: string[] = [];
  let current = '';
  let count = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const entry = text.slice(bounds[i], bounds[i + 1]);
    if (
      current.length > 0 &&
      (count >= maxTransactions || current.length + entry.length > maxChars)
    ) {
      chunks.push(current);
      current = '';
      count = 0;
    }
    current += entry;
    count += 1;
  }
  if (current.length > 0) chunks.push(current);

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
