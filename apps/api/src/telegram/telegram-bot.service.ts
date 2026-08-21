import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard } from 'grammy';
import { parseAmountOnly } from './capture-parser';
import {
  type BotReply,
  GuidedCaptureService,
  typeFromShort,
} from './guided-capture.service';
import { TelegramService } from './telegram.service';

const HELP_TEXT = [
  '💸 Quick-capture for your finance tracker — great for cash spends you would',
  'otherwise forget, with a note on what it was for.',
  '',
  'Fastest — send the amount, tap a category, then type a note (or skip):',
  '  40            expense → tap category → "lunch with Sam"',
  '  +2000         income',
  '',
  'After it saves you can tap: Undo · Change date · Change amount · Add note.',
  '(No note? Just carry on — the expense is already saved.)',
  '',
  'Prefer one line? Separate fields with " - ":',
  '  40 - dining out - lunch with friends',
  '  12.50 - groceries - snacks - 09.07',
  '  amount - category - note (optional) - date (optional: DD.MM /',
  '  DD.MM.YYYY / YYYY-MM-DD; default today).',
  '',
  'Commands:',
  '  /account — choose which account captures go to',
  '  /rate — view or set the exchange rate (e.g. /rate 540 → 1 EUR = 540 KZT)',
  '  /link <code> — connect this chat (get the code in the web app → Accounts)',
  '  /help — show this message',
].join('\n');

/**
 * Long-polling Telegram bot. Entirely optional: without TELEGRAM_BOT_TOKEN in
 * the environment the app runs as if this service did not exist (dev, CI, tests).
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Bot | null = null;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
    private readonly guided: GuidedCaptureService,
  ) {}

  onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.log('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
      return;
    }
    // Never long-poll the real bot from the test suite: it races app.close()
    // (jest hook timeouts) and would process live messages against the test DB.
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('NODE_ENV=test — Telegram bot disabled');
      return;
    }

    const bot = new Bot(token);

    bot.command(['start', 'help'], async (ctx) => {
      await ctx.reply(HELP_TEXT);
    });

    bot.command('link', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const code = ctx.match.trim();
      if (!code) {
        await ctx.reply(
          'Usage: /link <code> (from the web app, Accounts page)',
        );
        return;
      }
      const linked = await this.telegram.linkChat(code, String(ctx.chat.id));
      await ctx.reply(
        linked
          ? 'Linked! 🎉 Try it: send  40  then tap a category and add a note — or type it in one line:  40 - groceries - lunch.  /help for more.'
          : 'That code is invalid or expired — generate a fresh one in the web app.',
      );
    });

    bot.command('account', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const result = await this.telegram.listAccounts(String(ctx.chat.id));
      if (!result) {
        await ctx.reply(
          'This chat is not linked. Generate a code in the web app and send: /link <code>',
        );
        return;
      }
      if (result.accounts.length === 0) {
        await ctx.reply('No accounts yet — create one in the web app first.');
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const account of result.accounts) {
        const mark = account.id === result.defaultAccountId ? '✓ ' : '';
        keyboard.text(`${mark}${account.name}`, `acct:${account.id}`).row();
      }
      await ctx.reply('Pick the account new captures go to:', {
        reply_markup: keyboard,
      });
    });

    bot.command('rate', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const text = await this.telegram.handleRate(
        String(ctx.chat.id),
        ctx.match,
      );
      await ctx.reply(text);
    });

    bot.on('message:text', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const chatId = String(ctx.chat.id);

      // A just-booked capture may be waiting for a typed note / new amount; that
      // claims this message first, unless it's itself a fresh capture (then
      // applyPendingText returns null and we fall through as usual).
      const pending = await this.guided.applyPendingText(
        chatId,
        ctx.message.text,
      );
      if (pending) {
        await ctx.reply(pending.text, markup(pending));
        return;
      }

      // A message that is only an amount starts the button-driven picker;
      // anything richer still goes through the one-shot dash format.
      const amountOnly = parseAmountOnly(ctx.message.text);
      if (amountOnly) {
        const reply = await this.guided.start(
          chatId,
          amountOnly.type,
          amountOnly.amountCents,
        );
        await ctx.reply(reply.text, markup(reply));
        return;
      }

      const result = await this.telegram.capture(chatId, ctx.message.text);
      await ctx.reply(
        result.text,
        result.ok
          ? {
              reply_markup: new InlineKeyboard().text(
                'Undo',
                `undo:${result.transactionId}`,
              ),
            }
          : undefined,
      );
    });

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId === undefined) {
        await ctx.answerCallbackQuery();
        return;
      }
      if (data.startsWith('undo:')) {
        // The transaction is going away — drop any note/amount edit waiting on it.
        this.guided.clearPending(String(chatId));
        const text = await this.telegram.undoCapture(
          String(chatId),
          data.slice('undo:'.length),
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text);
        return;
      }
      if (data.startsWith('note:') || data.startsWith('amt:')) {
        const field = data.startsWith('note:') ? 'note' : 'amount';
        const id = data.slice(
          field === 'note' ? 'note:'.length : 'amt:'.length,
        );
        const reply = this.guided.promptEdit(String(chatId), field, id);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(reply.text, markup(reply));
        return;
      }
      if (data.startsWith('rdone:')) {
        const text = await this.telegram.markReminderDone(
          String(chatId),
          data.slice('rdone:'.length),
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text);
        return;
      }
      if (data.startsWith('acct:')) {
        const text = await this.telegram.setDefaultAccount(
          String(chatId),
          data.slice('acct:'.length),
        );
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text);
        return;
      }

      const reply = await this.routeGuided(String(chatId), data);
      await ctx.answerCallbackQuery();
      if (reply) {
        // Editing in place keeps the whole capture to a single message.
        await ctx.editMessageText(reply.text, markup(reply));
      }
    });

    bot.catch((err) => {
      this.logger.error(`Bot handler error: ${String(err.error)}`);
    });

    this.bot = bot;
    this.startPolling(bot);
  }

  /**
   * Dispatches the guided-capture callbacks. Each payload carries everything the
   * step needs, so no per-chat state is kept:
   *   p:<e|i>:<amount>                 show all categories ("More…" / back)
   *   g:<e|i>:<amount>:<Category>      show that category's subcategories
   *   b:<e|i>:<amount>:<subcategoryId> book it
   *   d:<transactionId>                offer recent dates
   *   s:<transactionId>:<YYYY-MM-DD>   apply a date
   */
  private async routeGuided(
    chatId: string,
    data: string,
  ): Promise<BotReply | null> {
    const [kind, ...rest] = data.split(':');

    if (kind === 'd' && rest.length === 1) {
      return this.guided.dateOptions(chatId, rest[0]);
    }
    if (kind === 's' && rest.length === 2) {
      return this.guided.setDate(chatId, rest[0], rest[1]);
    }

    const type = typeFromShort(rest[0] ?? '');
    const amount = Number(rest[1]);
    if (!type || !Number.isInteger(amount) || amount <= 0) return null;

    if (kind === 'p') return this.guided.categories(chatId, type, amount);
    if (kind === 'g' && rest[2]) {
      return this.guided.subcategories(
        chatId,
        type,
        amount,
        rest[2] as Parameters<GuidedCaptureService['subcategories']>[3],
      );
    }
    if (kind === 'b' && rest[2]) {
      return this.guided.book(chatId, type, amount, rest[2]);
    }
    return null;
  }

  /** Long polling for the lifetime of the app; a fatal crash (beyond grammY's
   *  own transient-error retries) restarts polling after a backoff instead of
   *  leaving the bot silently dead until the next deploy. */
  private startPolling(bot: Bot) {
    void bot
      .start({
        onStart: (me) => {
          this.telegram.botUsername = me.username;
          this.logger.log(`Telegram bot @${me.username} polling for updates`);
        },
      })
      .catch((err: unknown) => {
        if (this.stopping) return;
        this.logger.error(
          `Telegram polling crashed: ${String(err)} — restarting in 30s`,
        );
        setTimeout(() => this.startPolling(bot), 30_000);
      });
  }

  /**
   * Sends an unprompted message (the reminder nudges). Returns false when the
   * bot is disabled or Telegram rejects it — e.g. the user blocked the bot —
   * so the caller can carry on rather than treat it as a failed job.
   */
  async sendMessage(
    chatId: string,
    text: string,
    buttons?: { label: string; data: string }[],
  ): Promise<boolean> {
    if (!this.bot) return false;
    const keyboard = buttons?.length
      ? {
          reply_markup: buttons.reduce(
            (kb, b) => kb.text(b.label, b.data),
            new InlineKeyboard(),
          ),
        }
      : undefined;
    try {
      await this.bot.api.sendMessage(chatId, text, keyboard);
      return true;
    } catch (err: unknown) {
      this.logger.warn(`Could not message chat ${chatId}: ${String(err)}`);
      return false;
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.bot?.stop();
  }
}

/** Turns a reply's button grid into a grammY inline keyboard. */
function markup(reply: BotReply) {
  if (!reply.buttons || reply.buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const row of reply.buttons) {
    for (const button of row) {
      keyboard.text(button.label, button.data);
    }
    keyboard.row();
  }
  return { reply_markup: keyboard };
}
