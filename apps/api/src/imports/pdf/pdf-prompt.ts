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
