import { Injectable } from '@nestjs/common';
import type { TransactionCategory } from '@prisma/client';
import { BASE_CURRENCY } from '../fx/fx';
import { PrismaService } from '../prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import { parseAmountOnly, parseCapture } from './capture-parser';
import { confirmationText, localDateISO, localTodayISO, money } from './format';

/**
 * The button-driven capture flow: send a bare amount, then tap your way to a
 * category. Typing a subcategory name (and mistyping it) is the slowest part of
 * quick-capture, so the common ones are one tap away and the rest sit behind
 * "More…".
 *
 * The flow is deliberately **stateless**: the pending amount rides inside the
 * button's callback data, so a restart mid-capture loses nothing and there is no
 * per-chat session to expire. Telegram allows 64 bytes, and the longest payload
 * here ("b:e:<amount>:<uuid>") is around 45.
 */

export type Button = { label: string; data: string };
export type BotReply = {
  text: string;
  buttons?: Button[][];
  /** Set when a transaction was just created, so the bot can offer Undo. */
  transactionId?: string;
};

export type CaptureType = 'INCOME' | 'EXPENSE';

/** Buttons per row in the subcategory pickers. */
const COLUMNS = 2;
/** How many recent days the "Change date" picker offers. */
const DATE_CHOICES = 5;
/** How long a just-booked capture keeps listening for a follow-up note / amount
 *  edit typed as the next message. */
const PENDING_TTL_MS = 15 * 60_000;

const NOT_LINKED = 'This chat is not linked.';

/**
 * A just-booked transaction awaiting a free-text follow-up: a note (the default
 * right after booking) or a new amount (after "Change amount"). Held in memory
 * only for the short window between the prompt and the reply — the transaction
 * itself is always already saved, so nothing is lost if this is dropped.
 */
type Pending = { field: 'note' | 'amount'; transactionId: string; at: number };

@Injectable()
export class GuidedCaptureService {
  /** chatId → the transaction awaiting a typed note / amount (see Pending). */
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionService: TransactionService,
  ) {}

  /** Step 1 — a bare amount arrived: offer the pinned shortcuts. */
  async start(
    chatId: string,
    type: CaptureType,
    amountCents: number,
  ): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };

    const pinned = await this.prisma.subcategory.findMany({
      where: { userId: context.userId, pinned: true, ...signFilter(type) },
      orderBy: { name: 'asc' },
    });
    // Without shortcuts configured there is nothing to shortcut to — go
    // straight to the full category list rather than showing a lone "More…".
    if (pinned.length === 0) {
      return this.categories(chatId, type, amountCents);
    }

    return {
      text: `${this.prefix(type, amountCents, context.currency)} — pick a category:`,
      buttons: [
        ...rows(
          pinned.map((s) => ({
            label: s.name,
            data: `b:${short(type)}:${amountCents}:${s.id}`,
          })),
        ),
        [{ label: 'More…', data: `p:${short(type)}:${amountCents}` }],
      ],
    };
  }

  /** Step 2 — "More…": the categories that actually have subcategories. */
  async categories(
    chatId: string,
    type: CaptureType,
    amountCents: number,
  ): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };

    const groups = await this.prisma.subcategory.groupBy({
      by: ['category'],
      where: { userId: context.userId, ...signFilter(type) },
      _count: true,
    });
    if (groups.length === 0) {
      return { text: 'You have no categories for this yet — add one in the web app.' };
    }

    return {
      text: `${this.prefix(type, amountCents, context.currency)} — pick a category:`,
      buttons: rows(
        groups
          .sort((a, b) => a.category.localeCompare(b.category))
          .map((group) => ({
            label: `${group.category} (${group._count})`,
            data: `g:${short(type)}:${amountCents}:${group.category}`,
          })),
      ),
    };
  }

  /** Step 3 — the subcategories inside one category. */
  async subcategories(
    chatId: string,
    type: CaptureType,
    amountCents: number,
    category: TransactionCategory,
  ): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };

    // Income lives apart from every spending category, so a mismatch here means
    // the keyboard is stale (the amount's sign no longer fits the category).
    if ((category === 'Income') !== (type === 'INCOME')) {
      return {
        text: `${category} cannot be used for ${type === 'INCOME' ? 'income' : 'an expense'}.`,
      };
    }

    const found = await this.prisma.subcategory.findMany({
      where: { userId: context.userId, category },
      orderBy: { name: 'asc' },
    });
    if (found.length === 0) {
      return { text: `No subcategories in ${category}.` };
    }

    return {
      text: `${this.prefix(type, amountCents, context.currency)} · ${category}:`,
      buttons: [
        ...rows(
          found.map((s) => ({
            label: s.name,
            data: `b:${short(type)}:${amountCents}:${s.id}`,
          })),
        ),
        [{ label: '« Back', data: `p:${short(type)}:${amountCents}` }],
      ],
    };
  }

  /** Step 4 — book it (dated today), then invite a note as the next message. */
  async book(
    chatId: string,
    type: CaptureType,
    amountCents: number,
    subcategoryId: string,
  ): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };

    const subcategory = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId: context.userId },
    });
    if (!subcategory) return { text: 'That category no longer exists.' };
    // Guards against a stale keyboard from before a category was re-typed.
    if ((subcategory.category === 'Income') !== (type === 'INCOME')) {
      return {
        text: `"${subcategory.name}" cannot be used for ${type === 'INCOME' ? 'income' : 'an expense'}.`,
      };
    }

    const transaction = await this.transactionService.createTransaction(
      context.userId,
      {
        type,
        date: localTodayISO(),
        amount: amountCents,
        accountId: context.accountId,
        subcategoryId: subcategory.id,
      },
    );
    const account = await this.account(context.accountId);

    // Listen for a note typed as the very next message. The expense is already
    // saved, so ignoring the prompt (or sending the next amount) just leaves it
    // note-less — nothing to skip, nothing lost.
    this.setPending(chatId, 'note', transaction.id);

    return {
      transactionId: transaction.id,
      text:
        confirmationText({
          type,
          amountCents,
          amountBase: transaction.amountBase,
          subcategoryName: subcategory.name,
          account,
          outlier: transaction.outlier,
          baseCurrency: BASE_CURRENCY,
        }) + '\n\n📝 Reply with a note (what it was for) — optional.',
      buttons: editButtons(transaction.id),
    };
  }

  /** "Add note" / "Change amount" — start listening for the typed follow-up. */
  promptEdit(chatId: string, field: 'note' | 'amount', transactionId: string): BotReply {
    this.setPending(chatId, field, transactionId);
    return {
      text:
        field === 'note'
          ? 'Send the note (what it was for):'
          : 'Send the new amount (e.g. 12.50):',
    };
  }

  /**
   * Applies a typed follow-up to the pending transaction. Returns null when
   * there is nothing pending, or when the message is itself a fresh capture
   * (an amount, or the dash format) that should start a new capture instead —
   * so a bare "40" after booking is a new expense, not a note.
   */
  async applyPendingText(chatId: string, text: string): Promise<BotReply | null> {
    const p = this.pending.get(chatId);
    if (!p) return null;
    if (Date.now() - p.at > PENDING_TTL_MS) {
      this.pending.delete(chatId);
      return null;
    }

    // "Change amount" expects a number; a bare amount here is the edit, not a
    // new capture.
    if (p.field === 'amount') {
      const parsed = parseAmountOnly(text);
      if (!parsed) {
        // Keep listening — they mistyped the amount.
        return { text: 'That is not an amount. Send just the number, e.g. 12.50.' };
      }
      const context = await this.context(chatId);
      if ('error' in context) {
        this.pending.delete(chatId);
        return { text: context.error };
      }
      this.pending.delete(chatId);
      const updated = await this.transactionService.updateTransaction(
        context.userId,
        p.transactionId,
        { amount: parsed.amountCents },
      );
      const account = await this.account(context.accountId);
      return {
        transactionId: p.transactionId,
        text: `Amount updated.\n${this.summary(updated, account)}`,
        buttons: editButtons(p.transactionId),
      };
    }

    // p.field === 'note': a fresh capture (amount-only, or the dash format)
    // supersedes an unfilled note prompt, so a bare "40" is a new expense.
    if (parseAmountOnly(text) || parseCapture(text)) {
      this.pending.delete(chatId);
      return null;
    }
    const context = await this.context(chatId);
    if ('error' in context) {
      this.pending.delete(chatId);
      return { text: context.error };
    }
    this.pending.delete(chatId);
    const updated = await this.transactionService.updateTransaction(
      context.userId,
      p.transactionId,
      { description: text.trim() },
    );
    const account = await this.account(context.accountId);
    return {
      transactionId: p.transactionId,
      text: `📝 Noted.\n${this.summary(updated, account)}`,
      buttons: editButtons(p.transactionId),
    };
  }

  /** Forget any pending follow-up (e.g. after Undo deletes the transaction). */
  clearPending(chatId: string): void {
    this.pending.delete(chatId);
  }

  private setPending(
    chatId: string,
    field: 'note' | 'amount',
    transactionId: string,
  ): void {
    this.pending.set(chatId, { field, transactionId, at: Date.now() });
  }

  /** A compact one-line summary of a transaction after an edit. */
  private summary(
    t: { type: string; amount: number; description: string | null; subcategory: { name: string } | null },
    account: { name: string; currency: string; balance: number },
  ): string {
    const sign = t.type === 'INCOME' ? '+' : '−';
    const name = t.subcategory?.name ?? 'transaction';
    const note = t.description ? ` · ${t.description}` : '';
    return (
      `${sign}${money(t.amount, account.currency)} · ${name}${note}\n` +
      `${account.name}: ${money(account.balance, account.currency)}`
    );
  }

  /** "Change date" — offer the last few days. */
  async dateOptions(chatId: string, transactionId: string): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };

    const choices: Button[] = [];
    for (let offset = 0; offset < DATE_CHOICES; offset++) {
      const iso = localDateISO(offset);
      const label =
        offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : iso.slice(5);
      choices.push({ label, data: `s:${transactionId}:${iso}` });
    }
    return { text: 'Date it as:', buttons: rows(choices) };
  }

  /** Applies a date chosen from the picker. */
  async setDate(
    chatId: string,
    transactionId: string,
    dateISO: string,
  ): Promise<BotReply> {
    const context = await this.context(chatId);
    if ('error' in context) return { text: context.error };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { text: 'Invalid date.' };

    // updateTransaction re-converts the base amount for the new date's rate.
    const transaction = await this.transactionService.updateTransaction(
      context.userId,
      transactionId,
      { date: dateISO },
    );
    const account = await this.account(context.accountId);
    const name = transaction.subcategory?.name ?? 'transaction';
    return {
      text: `Moved to ${dateISO} · ${money(transaction.amount, account.currency)} · ${name}`,
      buttons: editButtons(transactionId),
    };
  }

  // ---- helpers ----

  /** The linked user and the account captures are booked to. */
  private async context(
    chatId: string,
  ): Promise<{ userId: string; accountId: string; currency: string } | { error: string }> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
      select: { id: true, defaultAccountId: true },
    });
    if (!user) return { error: NOT_LINKED };
    if (!user.defaultAccountId) {
      return {
        error:
          'No default account set. Pick one in the web app (Accounts page → Telegram).',
      };
    }
    const account = await this.prisma.account.findFirst({
      where: { id: user.defaultAccountId, userId: user.id },
      select: { id: true, currency: true },
    });
    if (!account) return { error: 'Your default account no longer exists.' };
    return {
      userId: user.id,
      accountId: account.id,
      currency: account.currency,
    };
  }

  private account(accountId: string) {
    return this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      // type feeds the below-zero warning (credit accounts are exempt).
      select: { name: true, currency: true, balance: true, type: true },
    });
  }

  private prefix(
    type: CaptureType,
    amountCents: number,
    currency: string,
  ): string {
    return `${type === 'INCOME' ? '+' : '−'}${money(amountCents, currency)}`;
  }
}

/** Income subcategories for income, everything else for expenses. */
function signFilter(type: CaptureType) {
  return {
    category: type === 'INCOME' ? ('Income' as const) : { not: 'Income' as const },
  };
}

/** Post-book actions: undo, or edit the date / amount / note in place. */
function editButtons(transactionId: string): Button[][] {
  return [
    [
      { label: 'Undo', data: `undo:${transactionId}` },
      { label: 'Change date', data: `d:${transactionId}` },
    ],
    [
      { label: 'Change amount', data: `amt:${transactionId}` },
      { label: 'Add note', data: `note:${transactionId}` },
    ],
  ];
}

function short(type: CaptureType): 'i' | 'e' {
  return type === 'INCOME' ? 'i' : 'e';
}

export function typeFromShort(value: string): CaptureType | null {
  if (value === 'i') return 'INCOME';
  if (value === 'e') return 'EXPENSE';
  return null;
}

function rows(buttons: Button[]): Button[][] {
  const out: Button[][] = [];
  for (let i = 0; i < buttons.length; i += COLUMNS) {
    out.push(buttons.slice(i, i + COLUMNS));
  }
  return out;
}
