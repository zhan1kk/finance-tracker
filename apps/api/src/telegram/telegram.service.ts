import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import { matchSubcategory, parseCapture } from './capture-parser';

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
      select: { telegramChatId: true, defaultAccountId: true },
    });
    return {
      linked: user.telegramChatId !== null,
      defaultAccountId: user.defaultAccountId,
      botUsername: this.botUsername,
    };
  }

  async updateSettings(userId: string, defaultAccountId: string | null) {
    if (defaultAccountId !== null) {
      const account = await this.prisma.account.findFirst({
        where: { id: defaultAccountId, userId },
      });
      if (!account) {
        throw new NotFoundException(
          `Account with id ${defaultAccountId} was not found`,
        );
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { defaultAccountId },
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
        date: parsed.date ?? new Date().toISOString().slice(0, 10),
        amount: parsed.amountCents,
        accountId: user.defaultAccountId,
        subcategoryId: result.match.id,
        description: parsed.description,
      },
    );
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: user.defaultAccountId },
      select: { name: true, currency: true, balance: true },
    });

    const sign = parsed.type === 'INCOME' ? '+' : '−';
    const note = parsed.description ? ` · ${parsed.description}` : '';
    const warning = transaction.outlier
      ? `\n⚠ Unusually ${transaction.outlier.direction} for ${result.match.name} (typical ~${this.money(transaction.outlier.medianCents, account.currency)})`
      : '';
    return {
      ok: true,
      transactionId: transaction.id,
      text:
        `Added ${sign}${this.money(parsed.amountCents, account.currency)} · ${result.match.name}${note}\n` +
        `${account.name}: ${this.money(account.balance, account.currency)}` +
        warning,
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
    return `New captures go to: ${account.name} (${this.money(account.balance, account.currency)})`;
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

  private money(cents: number, currency: string): string {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
      cents / 100,
    );
  }
}
