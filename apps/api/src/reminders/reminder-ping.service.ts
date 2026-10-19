import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import {
  nudgeButtons,
  TelegramBotService,
} from '../telegram/telegram-bot.service';
import { daysUntil, shouldPing } from './ping-schedule';

/** "1234" + EUR → "12.34 EUR". Plain on purpose: Telegram is not a spreadsheet. */
function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * Nudges the linked Telegram chat about payments coming due, on the user's own
 * lead time and interval (10 days out, then every 3 → 10, 7, 4, 1, and the day
 * itself). Opt-in per user; silent for everyone who has not turned it on.
 *
 * Runs once a day in the morning rather than continuously: a reminder is
 * information, not an alert, and one message a day is the most anyone wants.
 */
@Injectable()
export class ReminderPingService {
  private readonly logger = new Logger(ReminderPingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  @Cron('0 9 * * *')
  async sendDailyNudges(): Promise<{ users: number; sent: number }> {
    return this.run(new Date());
  }

  /** Split out from the cron so it can be driven with a fixed "today" in tests. */
  async run(today: Date): Promise<{ users: number; sent: number }> {
    const users = await this.prisma.user.findMany({
      where: {
        telegramRemindersEnabled: true,
        telegramChatId: { not: null },
      },
      select: {
        id: true,
        telegramChatId: true,
        baseCurrency: true,
        reminderLeadDays: true,
        reminderIntervalDays: true,
      },
    });

    let sent = 0;
    for (const user of users) {
      const due = await this.prisma.reminder.findMany({
        where: { userId: user.id, done: false, dueDate: { not: null } },
        orderBy: { dueDate: 'asc' },
        select: {
          id: true,
          label: true,
          dueDate: true,
          amountCents: true,
          currency: true,
          lastPingedOn: true,
        },
      });

      const todays = due.filter((r) => {
        const days = daysUntil(today, r.dueDate as Date);
        if (
          !shouldPing(days, user.reminderLeadDays, user.reminderIntervalDays)
        ) {
          return false;
        }
        // Guard against a second run on the same day (redeploy, manual trigger).
        return !r.lastPingedOn || daysUntil(r.lastPingedOn, today) > 0;
      });
      if (todays.length === 0) continue;

      // One message per reminder rather than one message listing all of them.
      // Settling edits the message it belongs to, and Telegram drops a
      // message's whole keyboard when its text is edited — so a combined nudge
      // lost the other reminders' buttons the moment you pressed any one of
      // them. Separate messages make that impossible instead of merely
      // unlikely, and each nudge can name its own amount and due date.
      const pinged: string[] = [];
      for (const r of todays) {
        const days = daysUntil(today, r.dueDate as Date);
        const when =
          days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
        const amount =
          r.amountCents === null
            ? ''
            : ` · ${money(r.amountCents, r.currency ?? user.baseCurrency)}`;
        const text = `⏰ ${r.label} — due ${when}${amount}`;

        const delivered = await this.bot.sendMessage(
          user.telegramChatId as string,
          text,
          nudgeButtons(r.id),
        );
        // A failed send is left unpinged so tomorrow's run tries it again.
        if (delivered) pinged.push(r.id);
      }
      if (pinged.length === 0) continue;
      sent += pinged.length;
      await this.prisma.reminder.updateMany({
        where: { id: { in: pinged } },
        data: { lastPingedOn: today },
      });
    }

    if (sent > 0) {
      this.logger.log(
        `Nudged ${users.length} user(s) about ${sent} payment(s)`,
      );
    }
    return { users: users.length, sent };
  }
}
