import { createHash } from 'node:crypto';
import type { TransactionType } from '@prisma/client';

/** Noise tokens common to card/bank statement descriptions. */
const NOISE_TOKENS = new Set([
  'pos',
  'card',
  'purchase',
  'payment',
  'pmt',
  'debit',
  'credit',
  'visa',
  'mastercard',
  'maestro',
  'contactless',
  'ecom',
  'ideal',
  'sepa',
  'tfr',
  'transfer',
  'ref',
  'transaction',
  'trans',
  'gmbh',
  'ltd',
  'bv',
  'inc',
]);

/**
 * Reduces a raw statement description to a stable merchant key: lowercase,
 * everything after a `*` dropped (card processor refs), long digit runs and
 * noise tokens removed, punctuation collapsed to single spaces. Deterministic,
 * so it doubles as the basis for the dedupe hash and rule matching.
 */
export function normalizeMerchant(raw: string): string {
  const beforeStar = raw.split('*')[0];
  const tokens = beforeStar
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => {
      if (token === '') return false;
      if (NOISE_TOKENS.has(token)) return false;
      // Drop pure-digit runs of 3+ (reference/card fragments), keep short ones.
      if (/^\d+$/.test(token) && token.length >= 3) return false;
      return true;
    });
  // Single-char tokens are usually legal-entity noise ("B.V." → "b v"); drop
  // them, but keep them if that would empty the key ("H&M" → "h m").
  const multiChar = tokens.filter((token) => token.length > 1);
  return (multiChar.length > 0 ? multiChar : tokens).join(' ').trim();
}

/**
 * Stable fingerprint of a transaction for duplicate detection across re-uploads.
 * Two rows collide only if they share account, calendar day, direction, amount
 * and normalized merchant.
 */
export function dedupeHash(input: {
  accountId: string;
  date: Date;
  type: TransactionType;
  amount: number;
  normalizedDescription: string;
}): string {
  const day = input.date.toISOString().slice(0, 10);
  const key = [
    input.accountId,
    day,
    input.type,
    input.amount,
    input.normalizedDescription,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
