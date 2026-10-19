import { Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { GuidedCaptureService } from './guided-capture.service';
import { TelegramBotService } from './telegram-bot.service';
import type { TelegramService } from './telegram.service';

/**
 * The reminder buttons, driven through grammY itself.
 *
 * "The Paid button does nothing" (1 October) was a press that settled the
 * reminder and then said nothing: the confirmation was the edited message, and
 * an edit Telegram refused swallowed it. Nothing could catch that without
 * pressing a button, so these do — the bot routes a real callback update, and
 * every call it makes to Telegram is recorded instead of sent.
 */
type Call = { method: string; payload: Record<string, unknown> };

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as UserFromGetMe;

function harness(opts: { refuseEdits?: boolean; gone?: boolean } = {}) {
  const telegram = {
    markReminderDone: jest
      .fn()
      .mockResolvedValue('✅ Rent paid. Next due 1 Nov.'),
    reminderLabel: jest.fn().mockResolvedValue(opts.gone ? null : 'Rent'),
    deleteReminder: jest
      .fn()
      .mockResolvedValue('🗑 Deleted: Rent. No more nudges for it.'),
  };
  const service = new TelegramBotService(
    { get: () => undefined } as never,
    telegram as unknown as TelegramService,
    {} as GuidedCaptureService,
  );

  const calls: Call[] = [];
  const bot = new Bot('123:test', { botInfo: BOT_INFO });
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (opts.refuseEdits && method.startsWith('editMessage')) {
      return Promise.resolve({
        ok: false,
        error_code: 400,
        description: "Bad Request: message can't be edited",
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  service.register(bot);

  /** Presses a button on a nudge in chat 55 (or on one too old to carry it). */
  const press = (data: string, withMessage = true) =>
    bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb1',
        from: { id: 55, is_bot: false, first_name: 'K' },
        chat_instance: 'ci',
        data,
        ...(withMessage
          ? {
              message: {
                message_id: 7,
                date: 0,
                chat: { id: 55, type: 'private', first_name: 'K' },
                text: '⏰ Rent — due today',
              },
            }
          : {}),
      },
    } as unknown as Update);

  const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery');
  const buttonsSetTo = () =>
    calls
      .filter((c) => c.method === 'editMessageReplyMarkup')
      .map((c) =>
        (
          c.payload.reply_markup as {
            inline_keyboard: { callback_data: string }[][];
          }
        ).inline_keyboard
          .flat()
          .map((b) => b.callback_data),
      );

  return { press, calls, answers, buttonsSetTo, telegram };
}

describe('TelegramBotService reminder buttons', () => {
  // Quiet the warnings these cases provoke on purpose.
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  describe('Paid', () => {
    it('confirms in the toast even when the message cannot be edited', async () => {
      const h = harness({ refuseEdits: true });
      await h.press('rdone:r1');

      expect(h.telegram.markReminderDone).toHaveBeenCalledWith('55', 'r1');
      expect(h.answers()).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: expect.objectContaining({
            text: '✅ Rent paid. Next due 1 Nov.',
          }) as unknown,
        },
      ]);
    });

    it('also rewrites the nudge when Telegram allows it', async () => {
      const h = harness();
      await h.press('rdone:r1');
      const edit = h.calls.find((c) => c.method === 'editMessageText');
      expect(edit?.payload.text).toBe('✅ Rent paid. Next due 1 Nov.');
    });

    it('says so when the nudge is too old to act on', async () => {
      const h = harness();
      await h.press('rdone:r1', false);
      expect(h.telegram.markReminderDone).not.toHaveBeenCalled();
      expect(h.answers()[0]?.payload).toMatchObject({ show_alert: true });
    });
  });

  describe('Delete', () => {
    it('asks first, and deletes nothing yet', async () => {
      const h = harness();
      await h.press('rdel:r1');

      expect(h.telegram.deleteReminder).not.toHaveBeenCalled();
      expect(h.buttonsSetTo()).toEqual([['rdelok:r1', 'rdelno:r1']]);
      expect(h.answers()).toHaveLength(1);
    });

    it('deletes on "Yes" and confirms it in the toast', async () => {
      const h = harness({ refuseEdits: true });
      await h.press('rdelok:r1');

      expect(h.telegram.deleteReminder).toHaveBeenCalledWith('55', 'r1');
      expect(h.answers()[0]?.payload).toMatchObject({
        text: '🗑 Deleted: Rent. No more nudges for it.',
      });
    });

    it('puts the nudge buttons back on "Keep it"', async () => {
      const h = harness();
      await h.press('rdelno:r1');

      expect(h.telegram.deleteReminder).not.toHaveBeenCalled();
      expect(h.buttonsSetTo()).toEqual([['rdone:r1', 'rdel:r1']]);
      expect(h.answers()[0]?.payload).toMatchObject({ text: 'Kept.' });
    });

    it('does not ask about a reminder that is already gone', async () => {
      const h = harness({ gone: true });
      await h.press('rdel:r1');

      expect(h.buttonsSetTo()).toEqual([]);
      expect(h.answers()[0]?.payload).toMatchObject({
        text: 'That reminder is gone already.',
      });
    });

    // Answered after the edit on purpose: a press can be answered once, so
    // answering first left no way to say the question never appeared.
    it('says so when the question cannot be shown, and deletes nothing', async () => {
      const h = harness({ refuseEdits: true });
      await h.press('rdel:r1');

      expect(h.telegram.deleteReminder).not.toHaveBeenCalled();
      expect(h.answers()).toHaveLength(1);
      expect(h.answers()[0]?.payload).toMatchObject({ show_alert: true });
    });
  });
});
