import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ReminderExtractionService } from './reminder-extraction.service';
import { looksLikeReminder, type ReminderCandidate } from './reminder-prompt';

// Fetch a bounded, recent window to scan — enough to cover the latest imports
// without loading a whole history, and the model only sees the hint-matching
// subset of these.
const SCAN_WINDOW = 500;
const MAX_CANDIDATES = 50;

@Injectable()
export class ReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly extraction: ReminderExtractionService,
  ) {}

  /** Open reminders first (soonest due), dismissed ones last. */
  list(userId: string) {
    return this.prisma.reminder.findMany({
      where: { userId },
      orderBy: [{ done: 'asc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Reads reminders out of recent transaction descriptions the user hasn't
   * scanned yet (each source transaction yields at most one reminder). On-demand
   * so an import never waits on the model.
   */
  async scan(userId: string): Promise<{ scanned: number; created: number }> {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        account: { userId },
        description: { not: null },
        // Skip anything that already produced a reminder — re-scan is additive.
        reminder: { is: null },
      },
      orderBy: { date: 'desc' },
      take: SCAN_WINDOW,
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        account: { select: { currency: true } },
      },
    });

    const candidates = transactions
      .filter((t) => looksLikeReminder(t.description))
      .slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) return { scanned: 0, created: 0 };

    // Alias rows to small indices for the model; map back on the way out.
    const byIndex = new Map<number, (typeof candidates)[number]>();
    const payload: ReminderCandidate[] = candidates.map((t, i) => {
      byIndex.set(i + 1, t);
      return {
        index: i + 1,
        date: t.date.toISOString().slice(0, 10),
        amount: t.amount / 100,
        currency: t.account.currency,
        description: t.description as string,
      };
    });

    const extracted = await this.extraction.extract(payload);

    let created = 0;
    for (const r of extracted) {
      const source = byIndex.get(r.index);
      if (!source) continue;
      const amountCents =
        r.amount != null ? Math.abs(Math.round(r.amount * 100)) : source.amount;
      try {
        await this.prisma.reminder.create({
          data: {
            userId,
            label: r.label,
            dueDate: r.dueDate ? new Date(r.dueDate) : null,
            amountCents,
            currency: source.account.currency,
            cadence: r.cadence,
            note: r.note,
            sourceTransactionId: source.id,
          },
        });
        created++;
      } catch (err) {
        // Unique(sourceTransactionId) — a reminder for this row already exists.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }
    return { scanned: candidates.length, created };
  }

  async update(userId: string, id: string, input: { done?: boolean }) {
    await this.assertOwn(userId, id);
    return this.prisma.reminder.update({
      where: { id },
      data: { done: input.done },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwn(userId, id);
    await this.prisma.reminder.delete({ where: { id } });
  }

  private async assertOwn(userId: string, id: string) {
    const found = await this.prisma.reminder.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }
  }
}
