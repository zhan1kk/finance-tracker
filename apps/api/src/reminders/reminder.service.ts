import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import type { CreateReminderDTO } from './dtos/create-reminder.dto';
import { ReminderExtractionService } from './reminder-extraction.service';
import { looksLikeReminder, type ReminderCandidate } from './reminder-prompt';

const REMINDER_INCLUDE = {
  subcategory: { select: { id: true, name: true, category: true } },
  // The transaction the reminder was read from — its type tells the UI whether
  // an "Ask …" reminder can be settled by linking an incoming payment.
  sourceTransaction: { select: { id: true, type: true, description: true } },
} satisfies Prisma.ReminderInclude;

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
    private readonly transactions: TransactionService,
  ) {}

  /** Open reminders first (soonest due), dismissed ones last. */
  list(userId: string) {
    return this.prisma.reminder.findMany({
      where: { userId },
      orderBy: [{ done: 'asc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
      include: REMINDER_INCLUDE,
    });
  }

  /** Add a reminder by hand (e.g. a subscription or bill). */
  async create(userId: string, input: CreateReminderDTO) {
    if (input.subcategoryId) {
      const subcategory = await this.prisma.subcategory.findFirst({
        where: { id: input.subcategoryId, userId },
        select: { id: true },
      });
      if (!subcategory) {
        throw new NotFoundException(
          `Subcategory with id ${input.subcategoryId} was not found`,
        );
      }
    }
    const isInstallment = input.installmentsTotal != null;
    return this.prisma.reminder.create({
      data: {
        userId,
        label: input.label,
        subcategoryId: input.subcategoryId ?? null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        amountCents: input.amountCents ?? null,
        currency: input.currency ?? null,
        cadence: input.cadence ?? null,
        installmentsTotal: input.installmentsTotal ?? null,
        // Paid count only means something for an installment plan.
        installmentsPaid: isInstallment ? (input.installmentsPaid ?? 0) : null,
        note: input.note ?? null,
      },
      include: REMINDER_INCLUDE,
    });
  }

  /**
   * Records the next installment as paid: bumps the count, moves the due date to
   * the next occurrence, and auto-completes the reminder once every payment is
   * in. Only valid on installment reminders.
   */
  async markPaid(userId: string, id: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, userId },
    });
    if (!reminder) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }
    if (reminder.installmentsTotal == null) {
      throw new BadRequestException(
        'This reminder is not an installment plan',
      );
    }
    const paid = Math.min(
      (reminder.installmentsPaid ?? 0) + 1,
      reminder.installmentsTotal,
    );
    const done = paid >= reminder.installmentsTotal;
    // Advance to the next payment date unless we're finished.
    const dueDate =
      !done && reminder.dueDate && reminder.cadence
        ? advanceDate(reminder.dueDate, reminder.cadence)
        : reminder.dueDate;

    return this.prisma.reminder.update({
      where: { id },
      data: { installmentsPaid: paid, done, dueDate },
      include: REMINDER_INCLUDE,
    });
  }

  /**
   * Settles an "Ask …" reminder when the friend's money arrives: links the given
   * INCOME as a reimbursement of the expense the reminder was read from (so it
   * nets out of spending), then marks the reminder done. Reuses the transaction
   * service's reimbursement validation (income must be INCOME, source EXPENSE).
   */
  async linkPayment(userId: string, id: string, incomeTransactionId: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, userId },
      select: { id: true, sourceTransactionId: true },
    });
    if (!reminder) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }
    if (!reminder.sourceTransactionId) {
      throw new BadRequestException(
        'This reminder has no source transaction to reimburse',
      );
    }
    await this.transactions.linkReimbursement(
      userId,
      incomeTransactionId,
      reminder.sourceTransactionId,
    );
    return this.prisma.reminder.update({
      where: { id },
      data: { done: true },
      include: REMINDER_INCLUDE,
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
      // If the model gave no date, approximate one so recurring bills and
      // installment plans still sort in and show up "due soon": step from the
      // source transaction by its cadence (installments assumed monthly) to the
      // next occurrence on/after today. Close enough — it isn't meant to be exact.
      let dueDate = r.dueDate ? new Date(r.dueDate) : null;
      if (!dueDate) {
        const cadence =
          r.cadence ?? (r.installmentsTotal != null ? 'monthly' : null);
        if (cadence) dueDate = nextOccurrence(source.date, cadence);
      }
      try {
        await this.prisma.reminder.create({
          data: {
            userId,
            label: r.label,
            dueDate,
            amountCents,
            currency: source.account.currency,
            cadence: r.cadence,
            installmentsTotal: r.installmentsTotal,
            installmentsPaid: r.installmentsTotal != null ? r.installmentsPaid : null,
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

/** The first occurrence on/after today, stepping from `from` by `cadence`. */
function nextOccurrence(from: Date, cadence: string): Date | null {
  let d = advanceDate(from, cadence);
  // advanceDate leaves the date unchanged for an unknown cadence — nothing to do.
  if (d.getTime() === from.getTime()) return null;
  const now = Date.now();
  let guard = 0;
  while (d.getTime() < now && guard++ < 600) {
    d = advanceDate(d, cadence);
  }
  return d;
}

/** Moves a date forward by one cadence period; unknown cadence → unchanged. */
function advanceDate(date: Date, cadence: string): Date {
  const d = new Date(date);
  switch (cadence) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      break;
  }
  return d;
}
