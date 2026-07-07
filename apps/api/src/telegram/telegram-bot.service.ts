import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard } from 'grammy';
import { TelegramService } from './telegram.service';

const HELP_TEXT = [
  'Quick-capture bot for your finance tracker.',
  '',
  'Add an expense:  12.50 groceries lunch with friends',
  'Add income:      +2000 salary july',
  '(amount · category · optional note — booked to your default account, dated today)',
  '',
  '/link <code> — connect this chat (get the code from the web app, Accounts page)',
  '/help — this message',
].join('\n');

/**
 * Long-polling Telegram bot. Entirely optional: without TELEGRAM_BOT_TOKEN in
 * the environment the app runs as if this service did not exist (dev, CI, tests).
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Bot | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
  ) {}

  onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.log('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
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
          ? 'Linked! Send me something like: 12.50 groceries lunch'
          : 'That code is invalid or expired — generate a fresh one in the web app.',
      );
    });

    bot.on('message:text', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      const result = await this.telegram.capture(
        String(ctx.chat.id),
        ctx.message.text,
      );
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
      if (!data.startsWith('undo:') || chatId === undefined) {
        await ctx.answerCallbackQuery();
        return;
      }
      const text = await this.telegram.undoCapture(
        String(chatId),
        data.slice('undo:'.length),
      );
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text);
    });

    bot.catch((err) => {
      this.logger.error(`Bot handler error: ${String(err.error)}`);
    });

    this.bot = bot;
    // Long polling runs for the lifetime of the app; never awaited.
    void bot
      .start({
        onStart: (me) => {
          this.telegram.botUsername = me.username;
          this.logger.log(`Telegram bot @${me.username} polling for updates`);
        },
      })
      .catch((err: unknown) => {
        this.logger.error(`Telegram polling stopped: ${String(err)}`);
      });
  }

  async onModuleDestroy() {
    await this.bot?.stop();
  }
}
