import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
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
        if (!shouldPing(days, user.reminderLeadDays, user.reminderIntervalDays)) {
          return false;
        }
        // Guard against a second run on the same day (redeploy, manual trigger).
        return (
          !r.lastPingedOn || daysUntil(r.lastPingedOn, today) > 0
        );
      });
      if (todays.length === 0) continue;

      const lines = todays.map((r) => {
        const days = daysUntil(today, r.dueDate as Date);
        const when =
          days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
        const amount =
          r.amountCents === null
            ? ''
            : ` · ${money(r.amountCents, r.currency ?? user.baseCurrency)}`;
        return `• ${r.label} — due ${when}${amount}`;
      });
      const text = [
        todays.length === 1 ? '⏰ Coming up' : `⏰ ${todays.length} coming up`,
        '',
        ...lines,
      ].join('\n');
      // One button per reminder, so settling does not need the web app.
      const buttons = todays.map((r) => ({
        label: todays.length === 1 ? '✓ Done' : `✓ ${r.label}`.slice(0, 30),
        data: `rdone:${r.id}`,
      }));

      const delivered = await this.bot.sendMessage(
        user.telegramChatId as string,
        text,
        buttons,
      );
      if (!delivered) continue;
      sent += todays.length;
      await this.prisma.reminder.updateMany({
        where: { id: { in: todays.map((r) => r.id) } },
        data: { lastPingedOn: today },
      });
    }

    if (sent > 0) {
      this.logger.log(`Nudged ${users.length} user(s) about ${sent} payment(s)`);
    }
    return { users: users.length, sent };
  }
}
