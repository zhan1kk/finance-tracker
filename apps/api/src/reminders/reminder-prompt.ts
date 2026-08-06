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

// Catches the shapes people write hints in — both future payments ("1/3
// payment", "next payment", "monthly", "by 15.09", "due …") and money owed
// between friends ("ask her", "owes", "shared w", "split", "paid for", "got
// back", "pay back"). Kept deliberately broad — the LLM does the real judging
// on whatever this lets through, and non-hints are dropped there.
const REMINDER_HINT =
  /(\d\s*\/\s*\d|next\s+(payment|instal?lment|in|due)|monthly|quarterly|weekly|yearly|annual|instal?lment|\brate\b|by\s+\d{1,2}[.\/]\d{1,2}|\bdue\b|remind|\bowe|\bask|\bshare|\bsplit|paid\s*for|pay\s*back|paid\s*back|paying\s*back|got\s*back|get\s*back|chip\s*in)/i;

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

export const REMINDER_SYSTEM_PROMPT = `You read bank-transaction descriptions and extract REMINDERS the person will want to act on later. There are two kinds:

1) UPCOMING PAYMENT — the description hints at a FUTURE related payment: an installment plan ("1/3 payment"), a recurring bill ("monthly", "next in Sep"), or an explicit due date.

2) MONEY OWED between the person and their friends — the description says a friend owes them, or they owe a friend, for a shared or covered cost. Examples: "50 is Alex's share, need to ask them", "shared w Sam", "got back from everyone but Jordan", "Alex paid for the tea", "paid for drinks, they'll pay me back".

For each row matching either kind, output one reminder; skip rows matching neither. Never invent reminders.

Fields per reminder:
- index: the row's number, copied exactly.
- label: a short, actionable title, ALWAYS derived from THIS row's own description/merchant. Never copy a word from the examples in this prompt — if the description says "TV", the label is about the TV, not a sofa.
  • Upcoming payment: name the actual thing being paid (its merchant or bill name, plus "installment"/"subscription" if that fits).
  • A friend owes THEM (collect it): start with "Ask" then the person's name, e.g. "Ask <name> for their share".
  • THEY owe a friend (pay it): start with "Pay" then the person's name, e.g. "Pay <name> back".
- amount: the amount as a number.
  • If the description states the owed amount ("50 is Alex's share"), use it.
  • If a cost is split with exactly one other person and no amount is stated, use half the transaction amount.
  • For an upcoming payment, use the stated amount, else the transaction's amount.
  • Omit only if truly indeterminable.
- dueDate: "YYYY-MM-DD" for upcoming payments (resolve relative hints against the transaction's date; "monthly" → one month later). Omit for money-owed reminders unless a date is stated.
- cadence: "monthly", "quarterly", "weekly", "yearly", or "one-off".
- installmentsTotal / installmentsPaid: only for a fixed-length plan written "N/M" (e.g. "1/3"), set installmentsTotal to M and installmentsPaid to N. Omit otherwise.
- note: brief context (what the cost was for). May be empty.

Return only the reminders array.`;

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
