import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { BASE_CURRENCY } from '../fx/fx';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import {
  matchSubcategory,
  parseCapture,
  parseCaptureDate,
} from './capture-parser';
import { confirmationText, localTodayISO, money } from './format';

const LINK_CODE_TTL_MS = 10 * 60 * 1000;

const CAPTURE_FORMAT_HINT =
  'Format: "40 - dining out - lunch with friends - 09.07" — amount - category - note (optional) - date (optional DD.MM or YYYY-MM-DD, default today). Separate fields with " - ". Prefix + for income: "+2000 - salary".';

export type CaptureResult =
  | { ok: true; text: string; transactionId: string }
  | { ok: false; text: string };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class TelegramService {
  /** Set by the bot once polling starts; null when the bot is not configured. */
  botUsername: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionService: TransactionService,
    private readonly fx: FxService,
  ) {}

  /** One-time code the user sends to the bot as `/link <code>`. */
  async createLinkCode(userId: string) {
    const code = randomBytes(4).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        telegramLinkCodeHash: sha256(code),
        telegramLinkCodeExpiresAt: expiresAt,
      },
    });
    return { code, expiresAt, botUsername: this.botUsername };
  }

  async getSettings(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        telegramChatId: true,
        defaultAccountId: true,
        telegramRemindersEnabled: true,
        reminderLeadDays: true,
        reminderIntervalDays: true,
      },
    });
    return {
      linked: user.telegramChatId !== null,
      defaultAccountId: user.defaultAccountId,
      botUsername: this.botUsername,
      remindersEnabled: user.telegramRemindersEnabled,
      leadDays: user.reminderLeadDays,
      intervalDays: user.reminderIntervalDays,
    };
  }

  async updateSettings(
    userId: string,
    patch: {
      defaultAccountId?: string | null;
      remindersEnabled?: boolean;
      leadDays?: number;
      intervalDays?: number;
    },
  ) {
    if (patch.defaultAccountId != null) {
      const account = await this.prisma.account.findFirst({
        where: { id: patch.defaultAccountId, userId },
      });
      if (!account) {
        throw new NotFoundException(
          `Account with id ${patch.defaultAccountId} was not found`,
        );
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      // Only the keys actually sent are written, so a settings form that
      // touches one field never resets the others.
      data: {
        ...(patch.defaultAccountId !== undefined
          ? { defaultAccountId: patch.defaultAccountId }
          : {}),
        ...(patch.remindersEnabled !== undefined
          ? { telegramRemindersEnabled: patch.remindersEnabled }
          : {}),
        ...(patch.leadDays !== undefined
          ? { reminderLeadDays: patch.leadDays }
          : {}),
        ...(patch.intervalDays !== undefined
          ? { reminderIntervalDays: patch.intervalDays }
          : {}),
      },
    });
    return this.getSettings(userId);
  }

  async unlink(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null },
    });
    return this.getSettings(userId);
  }

  // ---- bot-facing operations (chatId is the authenticated principal) ----

  /** Consumes a valid link code and binds the chat to its user. */
  async linkChat(code: string, chatId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: {
        telegramLinkCodeHash: sha256(code.trim()),
        telegramLinkCodeExpiresAt: { gt: new Date() },
      },
    });
    if (!user) {
      return false;
    }
    await this.prisma.$transaction([
      // Free the chat if it was linked to a different user before.
      this.prisma.user.updateMany({
        where: { telegramChatId: chatId },
        data: { telegramChatId: null },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          telegramChatId: chatId,
          telegramLinkCodeHash: null,
          telegramLinkCodeExpiresAt: null,
        },
      }),
    ]);
    return true;
  }

  /** Parses a text message from a linked chat and books the transaction. */
  async capture(chatId: string, text: string): Promise<CaptureResult> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!user) {
      return {
        ok: false,
        text: 'This chat is not linked. Generate a code in the web app (Accounts page) and send: /link <code>',
      };
    }
    if (!user.defaultAccountId) {
      return {
        ok: false,
        text: 'No default account set. Pick one in the web app (Accounts page → Telegram).',
      };
    }

    const parsed = parseCapture(text);
    if (!parsed) {
      return { ok: false, text: CAPTURE_FORMAT_HINT };
    }

    const subcategories = await this.prisma.subcategory.findMany({
      where: {
        userId: user.id,
        category: parsed.type === 'INCOME' ? 'Income' : { not: 'Income' },
      },
      orderBy: { name: 'asc' },
    });
    const result = matchSubcategory(subcategories, parsed.categoryQuery);
    if (!result.match) {
      const names = subcategories.map((s) => s.name).join(', ');
      return {
        ok: false,
        text:
          result.ambiguous.length > 0
            ? `"${parsed.categoryQuery}" is ambiguous: ${result.ambiguous.join(', ')}. Be more specific.`
            : `No category matches "${parsed.categoryQuery}". Yours: ${names}`,
      };
    }

    const transaction = await this.transactionService.createTransaction(
      user.id,
      {
        type: parsed.type,
        date: parsed.date ?? localTodayISO(),
        amount: parsed.amountCents,
        accountId: user.defaultAccountId,
        subcategoryId: result.match.id,
        description: parsed.description,
      },
    );
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: user.defaultAccountId },
      select: { name: true, currency: true, balance: true, type: true },
    });

    return {
      ok: true,
      transactionId: transaction.id,
      text: confirmationText({
        type: parsed.type,
        amountCents: parsed.amountCents,
        amountBase: transaction.amountBase,
        subcategoryName: result.match.name,
        description: parsed.description,
        account,
        outlier: transaction.outlier,
        baseCurrency: BASE_CURRENCY,
      }),
    };
  }

  /** The user's accounts + current default, for the /account picker. */
  async listAccounts(chatId: string) {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
      include: { accounts: { orderBy: { name: 'asc' } } },
    });
    if (!user) {
      return null;
    }
    return { accounts: user.accounts, defaultAccountId: user.defaultAccountId };
  }

  /** Switches which account captures are booked to (the /account buttons). */
  async setDefaultAccount(chatId: string, accountId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!user) {
      return 'This chat is not linked.';
    }
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId: user.id },
    });
    if (!account) {
      return 'That account was not found.';
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { defaultAccountId: account.id },
    });
    return `New captures go to: ${account.name} (${money(account.balance, account.currency)})`;
  }

  /**
   * `/rate` — view or set the foreign→base conversion rate. With no arguments it
   * reports the effective rate; otherwise it accepts a rate, an optional date
   * (default today) and an optional currency (default the one foreign currency):
   *   /rate 540            → 1 EUR = 540 KZT from today
   *   /rate 545 01.07      → from 1 July (current year)
   *   /rate KZT 550 2026-07-01
   */
  async handleRate(chatId: string, argsText: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!user) return 'This chat is not linked.';

    // The user's own currencies, not a built-in list: default to the first one
    // they actually track so /rate with no arguments means something to them.
    const tracked = (await this.fx.listPreferences(user.id)).currencies.map(
      (c) => c.currency,
    );
    const foreignDefault = tracked[0] ?? 'USD';
    const tokens = argsText.trim().split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      const info = await this.fx.listRates(user.id, foreignDefault);
      const lines = [
        `1 ${BASE_CURRENCY} = ${info.effectiveRate} ${foreignDefault} (in effect today)`,
      ];
      if (info.rates.length > 0) {
        lines.push('', 'Your overrides:');
        for (const rate of info.rates.slice(0, 5)) {
          lines.push(
            `• ${rate.date.toISOString().slice(0, 10)}: 1 ${BASE_CURRENCY} = ${rate.rate} ${rate.currency}`,
          );
        }
      }
      lines.push(
        '',
        `Set:  /rate 540   ·   /rate 545 01.07   ·   /rate ${foreignDefault} 550 2026-07-01`,
      );
      return lines.join('\n');
    }

    let currency = foreignDefault;
    let dateISO = localTodayISO();
    let rate: number | undefined;
    for (const token of tokens) {
      if (/^[A-Za-z]{3}$/.test(token)) {
        const code = token.toUpperCase();
        if (code === BASE_CURRENCY) {
          return `${BASE_CURRENCY} is the base currency — set a foreign currency's rate, e.g. ${foreignDefault}.`;
        }
        if (tracked.length > 0 && !tracked.includes(code)) {
          return `You don't track ${code} yet. Yours: ${tracked.join(', ')}. Add it under Exchange rates in the web app.`;
        }
        currency = code;
      } else if (parseCaptureDate(token)) {
        dateISO = parseCaptureDate(token) as string;
      } else if (/^\d+(?:[.,]\d+)?$/.test(token)) {
        rate = parseFloat(token.replace(',', '.'));
      } else {
        return `Didn't understand "${token}". Try:  /rate 540   or   /rate 545 01.07`;
      }
    }

    if (rate === undefined || !(rate > 0)) {
      return `Give a positive rate, e.g. /rate 540 (means 1 ${BASE_CURRENCY} = 540 ${foreignDefault}).`;
    }

    const result = await this.fx.setRate(user.id, currency, dateISO, rate);
    const recomputed =
      result.recomputed > 0
        ? ` Updated ${result.recomputed} existing ${currency} transaction(s).`
        : '';
    return `Set 1 ${BASE_CURRENCY} = ${rate} ${currency} from ${dateISO}.${recomputed}`;
  }

  /** Deletes a just-captured transaction (the Undo button). */
  async undoCapture(chatId: string, transactionId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!user) {
      return 'This chat is not linked.';
    }
    try {
      await this.transactionService.deleteTransaction(user.id, transactionId);
      return 'Undone — transaction removed and the balance restored.';
    } catch {
      return 'Could not undo (already removed?).';
    }
  }

  /** Settles a reminder from its nudge message. Scoped to the chat's own user. */
  async markReminderDone(chatId: string, reminderId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!user) return 'This chat is not linked.';
    const { count } = await this.prisma.reminder.updateMany({
      where: { id: reminderId, userId: user.id },
      data: { done: true },
    });
    return count > 0
      ? '✅ Marked done.'
      : 'That reminder is gone already.';
  }
}
