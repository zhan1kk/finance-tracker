/**
 * Prompt, schema, and helpers for extracting upcoming-payment reminders from
 * transaction descriptions with a local Ollama model. A cheap keyword
 * pre-filter runs first so the model only ever sees rows that plausibly hint at
 * a future payment.
 */

export type ExtractedReminder = {
  index: number;
  label: string;
  dueDate: string | null;
  amount: number | null;
  cadence: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  note: string | null;
};

/** Candidate row fed to the extractor (aliased index → source transaction). */
export type ReminderCandidate = {
  index: number;
  date: string;
  amount: number;
  currency: string;
  description: string;
};

// Catches the shapes people write future-payment hints in: "1/3 payment",
// "next payment", "monthly", "by 15.09", "installment/Rate", "due …". Kept
// deliberately broad — the LLM does the real judging on whatever this lets
// through, and non-hints are dropped there.
const REMINDER_HINT =
  /(\d\s*\/\s*\d|next\s+(payment|instal?lment|in|due)|monthly|quarterly|weekly|yearly|annual|instal?lment|\brate\b|by\s+\d{1,2}[.\/]\d{1,2}|\bdue\b|remind)/i;

export function looksLikeReminder(description: string | null): boolean {
  return !!description && REMINDER_HINT.test(description);
}

/** Ollama structured-output schema: reminders keyed back to input rows. */
export const REMINDER_EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    reminders: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          index: { type: 'integer' as const },
          label: { type: 'string' as const },
          dueDate: { type: 'string' as const },
          amount: { type: 'number' as const },
          cadence: { type: 'string' as const },
          installmentsTotal: { type: 'integer' as const },
          installmentsPaid: { type: 'integer' as const },
          note: { type: 'string' as const },
        },
        required: ['index', 'label'],
      },
    },
  },
  required: ['reminders'],
};

export const REMINDER_SYSTEM_PROMPT = `You extract UPCOMING-PAYMENT reminders from bank-transaction descriptions.

Each input row is a transaction that already happened, but its description may hint at a FUTURE related payment (an installment plan, a monthly bill, "next payment …"). For each row that genuinely describes a future payment, output one reminder; skip rows that don't.

For each reminder:
- index: the row's number, copied exactly.
- label: a short name of what the payment is for (e.g. "TV Tax", "ImmoScout", "Sofa installment").
- dueDate: the next payment date as "YYYY-MM-DD". Resolve relative hints against the transaction's own date ("next in Sep" → the first September after it; "monthly" → one month later). Omit if truly unknown.
- amount: the expected amount as a number. If the hint states one, use it; otherwise use the transaction's amount.
- cadence: "monthly", "quarterly", "weekly", "yearly", or "one-off".
- installmentsTotal / installmentsPaid: for a fixed-length plan written "N/M" (e.g. "1/3 payment"), set installmentsTotal to M and installmentsPaid to N (this payment already happened). Omit both when there is no such count.
- note: any extra detail. May be empty.

Return only the reminders array. Do not invent reminders for rows with no future-payment hint.`;

export function buildReminderPrompt(candidates: ReminderCandidate[]): string {
  const lines = candidates.map(
    (c) =>
      `${c.index}. date=${c.date}, amount=${c.amount} ${c.currency}, description="${c.description}"`,
  );
  return `Rows:\n${lines.join('\n')}\n\nExtract the upcoming-payment reminders as JSON.`;
}

/** Validates model output into clean rows, dropping anything unusable. */
export function coerceExtractedReminders(raw: unknown): ExtractedReminder[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedReminder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const index = typeof r.index === 'number' ? r.index : Number(r.index);
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!Number.isInteger(index) || label === '') continue;
    const amount =
      typeof r.amount === 'number'
        ? r.amount
        : r.amount != null && r.amount !== ''
          ? Number(r.amount)
          : null;
    const dueDate =
      typeof r.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate.trim())
        ? r.dueDate.trim()
        : null;
    const cadence =
      typeof r.cadence === 'string' && r.cadence.trim() !== ''
        ? r.cadence.trim().toLowerCase()
        : null;
    const note =
      typeof r.note === 'string' && r.note.trim() !== '' ? r.note.trim() : null;
    // A valid installment plan needs a total of at least 2; paid clamps to it.
    const total = toInt(r.installmentsTotal);
    const installmentsTotal = total != null && total >= 2 ? total : null;
    const paid = toInt(r.installmentsPaid);
    const installmentsPaid =
      installmentsTotal != null
        ? Math.max(0, Math.min(paid ?? 0, installmentsTotal))
        : null;
    out.push({
      index,
      label,
      dueDate,
      amount: amount != null && Number.isFinite(amount) ? amount : null,
      cadence,
      installmentsTotal,
      installmentsPaid,
      note,
    });
  }
  return out;
}

function toInt(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : v != null && v !== '' ? Number(v) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}
