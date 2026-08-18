/**
 * Prompt, schema, and helpers for extracting upcoming-payment reminders from
 * transaction descriptions with a local Ollama model. A cheap keyword
 * pre-filter runs first so the model only ever sees rows that plausibly hint at
 * a future payment.
 */

export type ReminderKind = 'payment' | 'ask' | 'pay';

export type ExtractedReminder = {
  index: number;
  label: string;
  /** payment = a bill/subscription; ask = a friend owes you; pay = you owe a friend. */
  kind: ReminderKind;
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
  /** The row's subcategory name, passed to the model for grounding. */
  category?: string | null;
};

/**
 * Reads an "N/M" installment marker (e.g. "1/3", "7/12", "3/42") out of a
 * description — deterministically, no model. Returns paid=N, total=M. Rejects
 * dates and ratios the same way: "15/09" and "24/7" have N>M, "1/2026" exceeds
 * the installment-count cap, and an "X/X" with X≥10 (e.g. "50/50") reads as a
 * split, not a final payment.
 */
export function extractInstallment(
  description: string | null,
): { paid: number; total: number } | null {
  if (!description) return null;
  const re = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,3})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const paid = Number(m[1]);
    const total = Number(m[2]);
    if (
      total >= 2 &&
      total <= 60 &&
      paid >= 1 &&
      paid <= total &&
      !(paid === total && total >= 10)
    ) {
      return { paid, total };
    }
  }
  return null;
}

/**
 * A stable label for a deterministic installment reminder: the transaction's
 * own subcategory name when it has one (reliable, human-set), else the
 * description with the N/M marker and separators stripped. Never invented — so
 * a dentist-financing "Bfs · 7/12" row keeps its real category, not a guess.
 */
export function installmentLabel(
  description: string,
  subcategoryName: string | null,
): string {
  if (subcategoryName && subcategoryName.trim()) return subcategoryName.trim();
  const cleaned = description
    .replace(/(?<!\d)\d{1,2}\s*\/\s*\d{1,3}(?!\d)/g, ' ')
    .replace(/[·|,/–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Installment payment';
}

// Money-owed hints only — the LLM scan is scoped to IOUs between friends now
// that installments are read deterministically above and recurring bills are
// detected separately. Kept broad; the model does the final judging.
const IOU_HINT =
  /(\bowe|\bask|\bshare|\bsplit|paid\s*for|(?:pay(?:ing)?|paid|give|giving|gave|send|sending|sent|transfer)\s*(?:it\s*)?back|(?:get|got|getting)\s*(?:it\s*)?back|chip\s*in|\bIOU\b|\bdebt)/i;

export function looksLikeIou(description: string | null): boolean {
  return !!description && IOU_HINT.test(description);
}

/**
 * Money the user is waiting to receive back from a merchant, not a person: a
 * return that has not been refunded yet, a cancelled booking, a disputed
 * charge. Worth a reminder because the refund lands as a separate transaction
 * later and has to be linked to this expense by hand — nothing else will
 * connect the two, and until it is linked the expense looks like real spending.
 *
 * Deliberately requires a *pending* sense: "refund received" or "refunded on
 * the 3rd" is already settled and must not raise a reminder. Direction is the
 * caller's job — only an EXPENSE can be awaiting a refund; an INCOME row saying
 * "refund" *is* the refund.
 */
const REFUND_PENDING_HINT =
  /(refund|reimburse|money\s*back|charge\s*back|chargeback)/i;
const REFUND_SETTLED_HINT =
  /(refunded|reimbursed|refund\s+(?:received|arrived|came|is\s*here|done))/i;
const RETURN_HINT = /(returned|sent\s*back|sending\s*back|cancell?ed)/i;

/** Merchant-ish label for a refund reminder: the text before the first note. */
export function refundLabel(description: string): string {
  const head = description.split(/[·(]/)[0].replace(/\s+/g, ' ').trim();
  const label = head || description.trim();
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

export function looksLikeExpectedRefund(description: string | null): boolean {
  if (!description) return false;
  if (REFUND_SETTLED_HINT.test(description)) return false;
  return (
    REFUND_PENDING_HINT.test(description) || RETURN_HINT.test(description)
  );
}

/** Ollama structured-output schema: money-owed reminders keyed back to rows. */
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
          kind: {
            type: 'string' as const,
            enum: ['ask', 'pay'] as const,
          },
          amount: { type: 'number' as const },
          note: { type: 'string' as const },
        },
        required: ['index', 'label', 'kind'],
      },
    },
  },
  required: ['reminders'],
};

export const REMINDER_SYSTEM_PROMPT = `You read bank-transaction descriptions and extract ONLY reminders about MONEY OWED between the person and their friends. Ignore everything else — bills, subscriptions, and installment plans are handled elsewhere, so never output them.

A row is money-owed when the description says a friend owes the person, or the person owes a friend, for a shared or covered cost. Examples: "50 is Alex's share, need to ask them", "shared w Sam", "got back from everyone but Jordan", "Alex paid for the tea", "paid for drinks, they'll pay me back".

For each money-owed row output one reminder; skip every row that is not clearly money owed between people. Never invent one.

Fields per reminder:
- index: the row's number, copied exactly.
- label: a short title derived from THIS row. If a friend owes the person, start with "Ask" then the person's name, e.g. "Ask Alex for their share". If the person owes a friend, start with "Pay" then the person's name, e.g. "Pay Sam back". Use the name from the description; if there is no name, use "Ask for their share" / "Pay back". Never copy a name from the examples above.
- kind: "ask" when a friend owes the person, "pay" when the person owes a friend. Must match the label.
- amount: the owed amount as a number. If the description states it ("50 is Alex's share"), use that. If a cost is split with exactly one other person and no amount is stated, use half the row's amount. Omit if truly indeterminable.
- note: brief context (what the cost was for). May be empty.

Return only the reminders array.`;

export function buildReminderPrompt(candidates: ReminderCandidate[]): string {
  const lines = candidates.map((c) => {
    const cat = c.category ? `, category="${c.category}"` : '';
    return `${c.index}. date=${c.date}, amount=${c.amount} ${c.currency}${cat}, description="${c.description}"`;
  });
  return `Rows:\n${lines.join('\n')}\n\nExtract only the money-owed reminders as JSON.`;
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
    const kind = coerceKind(r.kind, label);
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
      kind,
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

/**
 * The reminder's kind: the model's value if valid, otherwise inferred from the
 * label (money-owed reminders are prefixed "Ask …" / "Pay …"), defaulting to a
 * plain payment. Keeps the payments-vs-IOUs split reliable even if the model
 * omits or mislabels the field.
 */
function coerceKind(value: unknown, label: string): ReminderKind {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'ask' || v === 'pay' || v === 'payment') return v;
  if (/^ask\b/i.test(label)) return 'ask';
  if (/^pay\s/i.test(label)) return 'pay';
  return 'payment';
}

function toInt(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : v != null && v !== '' ? Number(v) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}
