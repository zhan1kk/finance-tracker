import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TransactionService } from '../transactions/transaction.service';
import type { CreateReminderDTO } from './dtos/create-reminder.dto';
import { ReminderExtractionService } from './reminder-extraction.service';
import {
  extractInstallment,
  installmentLabel,
  looksLikeIou,
  type ReminderCandidate,
} from './reminder-prompt';
import { detectRecurringBills } from './recurring-detect';

// Cadences a plain (non-installment) recurring reminder can roll forward on
// when it's marked paid for the period.
const RECURRING_CADENCES = new Set(['weekly', 'monthly', 'quarterly', 'yearly']);

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
// Smaller batches keep the single Ollama generation short — important on a
// RAM/disk-constrained machine where a long prompt makes the whole system lag.
const MAX_CANDIDATES = 25;

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

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
   * Marks the current payment as done. For an installment plan: bumps the count,
   * moves the due date to the next occurrence, and auto-completes once every
   * payment is in. For a plain recurring bill (a cadence + a due date, no fixed
   * plan): rolls the due date forward one period and keeps the reminder open, so
   * it nags again next cycle instead of being dismissed forever. Anything else
   * (a one-off with no cadence) has nothing to advance — dismiss it with Done.
   */
  async markPaid(userId: string, id: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, userId },
    });
    if (!reminder) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }

    if (reminder.installmentsTotal != null) {
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

    if (
      reminder.dueDate &&
      reminder.cadence &&
      RECURRING_CADENCES.has(reminder.cadence)
    ) {
      return this.prisma.reminder.update({
        where: { id },
        data: { dueDate: advanceDate(reminder.dueDate, reminder.cadence) },
        include: REMINDER_INCLUDE,
      });
    }

    throw new BadRequestException(
      'This reminder has nothing to advance — use Done to dismiss it.',
    );
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
   * so an import never waits on the model. Two independent passes:
   *   1. installments ("N/M") — deterministic, no model, so there's nothing to
   *      hallucinate and it works even when Ollama is down;
   *   2. money owed between friends — the only job left to the local model, kept
   *      best-effort so an Ollama failure never loses the installments above.
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
        subcategory: { select: { name: true } },
      },
    });

    let scanned = 0;
    let created = 0;

    // Pass 1 — deterministic installments. The count and label come straight
    // from the row (its subcategory name), never from a model guess.
    const iouRows: typeof transactions = [];
    for (const t of transactions) {
      const desc = t.description as string;
      const inst = extractInstallment(desc);
      if (!inst) {
        if (looksLikeIou(desc)) iouRows.push(t);
        continue;
      }
      // A fully-paid plan ("3/3") has nothing left to remind about.
      if (inst.paid >= inst.total) continue;
      scanned++;
      const madeOne = await this.createSafely({
        userId,
        label: installmentLabel(desc, t.subcategory?.name ?? null),
        kind: 'payment',
        // One month after this charge — not stepped into the future, so the next
        // installment shows as overdue if it fell due before it was imported.
        dueDate: advanceDate(t.date, 'monthly'),
        amountCents: t.amount,
        currency: t.account.currency,
        cadence: 'monthly',
        installmentsTotal: inst.total,
        installmentsPaid: inst.paid,
        sourceTransactionId: t.id,
      });
      if (madeOne) created++;
    }

    // Pass 2 — money owed, via the local model, on the IOU-hint rows only.
    const rows = iouRows.slice(0, MAX_CANDIDATES);
    if (rows.length > 0) {
      scanned += rows.length;
      const byIndex = new Map<number, (typeof transactions)[number]>();
      const payload: ReminderCandidate[] = rows.map((t, i) => {
        byIndex.set(i + 1, t);
        return {
          index: i + 1,
          date: t.date.toISOString().slice(0, 10),
          amount: t.amount / 100,
          currency: t.account.currency,
          description: t.description as string,
          category: t.subcategory?.name ?? null,
        };
      });
      try {
        const extracted = await this.extraction.extract(payload);
        for (const r of extracted) {
          // The IOU pass only ever creates money-owed reminders.
          if (r.kind !== 'ask' && r.kind !== 'pay') continue;
          const source = byIndex.get(r.index);
          if (!source) continue;
          const amountCents =
            r.amount != null
              ? Math.abs(Math.round(r.amount * 100))
              : source.amount;
          const madeOne = await this.createSafely({
            userId,
            label: r.label,
            kind: r.kind,
            dueDate: r.dueDate ? new Date(r.dueDate) : null,
            amountCents,
            currency: source.account.currency,
            note: r.note,
            sourceTransactionId: source.id,
          });
          if (madeOne) created++;
        }
      } catch (err) {
        // Ollama unavailable or slow — keep the deterministic results and move
        // on rather than failing the whole scan.
        this.logger.warn(
          `Money-owed scan skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { scanned, created };
  }

  /**
   * Creates a reminder, swallowing the unique(sourceTransactionId) clash — a
   * reminder for that row already exists — so a re-scan is idempotent. Returns
   * whether a new reminder was actually created.
   */
  private async createSafely(
    data: Prisma.ReminderUncheckedCreateInput,
  ): Promise<boolean> {
    try {
      await this.prisma.reminder.create({ data });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Deterministically detects recurring Bills/Subscriptions (same subcategory
   * repeating monthly or quarterly, ±5 days) and creates an upcoming-payment
   * reminder for each next occurrence — plus obvious cases (Rent, Deutschland
   * Ticket) from a single charge. Skips a subcategory that already has an open
   * reminder or a recurring rule, so it never double-nags. No LLM involved.
   */
  async detectRecurring(userId: string): Promise<{ created: number }> {
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 12);
    const txns = await this.prisma.transaction.findMany({
      where: {
        account: { is: { userId } },
        type: 'EXPENSE',
        excludeFromStats: false,
        // A charge already posted by a recurring rule is handled there — don't
        // detect it as a "new" recurring bill and nag twice.
        recurringRuleId: null,
        date: { gte: since },
        subcategory: { is: { category: { in: ['Bills', 'Subscriptions'] } } },
      },
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        account: { select: { currency: true } },
        subcategory: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });

    const bills = txns
      .filter((t) => t.subcategory !== null)
      .map((t) => ({
        id: t.id,
        date: t.date,
        amount: t.amount,
        currency: t.account.currency,
        subcategoryId: t.subcategory!.id,
        name: t.subcategory!.name,
        description: t.description,
      }));
    const candidates = detectRecurringBills(bills, new Date());
    if (candidates.length === 0) return { created: 0 };

    // Don't remind about a subcategory already covered by an open reminder or a
    // recurring rule that posts it automatically.
    const [reminded, ruled] = await Promise.all([
      this.prisma.reminder.findMany({
        where: { userId, done: false, subcategoryId: { not: null } },
        select: { subcategoryId: true },
      }),
      this.prisma.recurringRule.findMany({
        where: { userId },
        select: { subcategoryId: true },
      }),
    ]);
    const covered = new Set<string>([
      ...reminded.map((r) => r.subcategoryId as string),
      ...ruled.map((r) => r.subcategoryId),
    ]);

    let created = 0;
    for (const c of candidates) {
      if (covered.has(c.subcategoryId)) continue;
      const madeOne = await this.createSafely({
        userId,
        label: c.label,
        kind: 'payment',
        dueDate: c.nextDate,
        amountCents: c.amountCents,
        currency: c.currency,
        cadence: c.cadence,
        subcategoryId: c.subcategoryId,
        sourceTransactionId: c.sourceTransactionId,
        installmentsTotal: c.installmentsTotal,
        installmentsPaid:
          c.installmentsTotal != null ? c.installmentsPaid : null,
      });
      if (madeOne) created++;
    }
    return { created };
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
