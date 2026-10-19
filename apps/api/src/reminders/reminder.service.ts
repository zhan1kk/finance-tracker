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
  looksLikeExpectedRefund,
  looksLikeIou,
  refundLabel,
  type ReminderCandidate,
} from './reminder-prompt';
import { detectRecurringBills } from './recurring-detect';
import { advanceDate, planDeletion, planSettlement } from './settle';
import { startOfUtcDay } from '../common/date';

const REMINDER_INCLUDE = {
  subcategory: { select: { id: true, name: true, category: true } },
  // The transaction the reminder was read from — its type tells the UI whether
  // an "Ask …" reminder can be settled by linking an incoming payment.
  sourceTransaction: { select: { id: true, type: true, description: true } },
  // Shown on the row so a reminder scoped to one card says which one.
  account: { select: { id: true, name: true } },
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
  async list(userId: string) {
    // Self-heal first: advance any payment reminder past months already paid,
    // so a settled bill/installment stops showing as due/overdue. Whether the
    // payment was imported or typed in by hand makes no difference.
    await this.reconcile(userId);
    return this.prisma.reminder.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ done: 'asc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
      include: REMINDER_INCLUDE,
    });
  }

  /**
   * Advances open payment reminders (bills/installments with a cadence and a
   * category) past every period that already has a matching, non-internal
   * expense on/after the due date — a payment you have made, whether it was
   * imported from a statement or entered by hand.
   * Installments also bump their paid count and auto-complete. Idempotent: once
   * the due date sits beyond the latest matching transaction, nothing changes,
   * so it's safe to run on every list. Best-effort — a failure never breaks the
   * list.
   */
  private async reconcile(userId: string): Promise<void> {
    try {
      const reminders = await this.prisma.reminder.findMany({
        where: {
          userId,
          done: false,
          kind: 'payment',
          subcategoryId: { not: null },
          dueDate: { not: null },
          cadence: { in: ['weekly', 'monthly', 'quarterly', 'yearly'] },
        },
        select: {
          id: true,
          subcategoryId: true,
          accountId: true,
          dueDate: true,
          cadence: true,
          installmentsTotal: true,
          installmentsPaid: true,
        },
      });

      // One query for the whole set, not one per reminder. reconcile runs on
      // every list(), so a bill each for rent, phone, gym and the rest was
      // that many sequential round trips before the page could render.
      //
      // The floor is the earliest due date among them: anything older than
      // that cannot settle any of these reminders, and each reminder still
      // applies its own date below. Payments come back newest-first, so the
      // first row matching a reminder is its latest payment.
      const earliest = Math.min(
        ...reminders.map((r) => (r.dueDate as Date).getTime()),
      );
      const payments = await this.prisma.transaction.findMany({
        where: {
          account: { is: { userId } },
          type: 'EXPENSE',
          excludeFromStats: false,
          subcategoryId: {
            in: [...new Set(reminders.map((r) => r.subcategoryId as string))],
          },
          date: { gte: startOfUtcDay(new Date(earliest)) },
        },
        orderBy: { date: 'desc' },
        select: { date: true, subcategoryId: true, accountId: true },
      });

      for (const r of reminders) {
        const dueDate = r.dueDate as Date;
        // The latest matching payment on/after this reminder's own due date.
        // Compared from the start of that day, not the instant: a due date
        // inherits the time of day from the statement line it was read out of,
        // and a payment entered by hand sits at midnight, which made your own
        // entry on the due date look too early.
        const from = startOfUtcDay(dueDate).getTime();
        const latest = payments.find(
          (p) =>
            p.subcategoryId === r.subcategoryId &&
            // Scoped to one account when the reminder names one. Two people
            // sharing a category — each paying their own gym membership from
            // their own card — are identical by category, so without this
            // either payment settles both reminders.
            (r.accountId === null || p.accountId === r.accountId) &&
            p.date.getTime() >= from,
        );
        if (!latest) continue;

        let next = dueDate;
        let paid = r.installmentsPaid ?? 0;
        const total = r.installmentsTotal;
        let done = false;
        let guard = 0;
        // Same day-level comparison as the query above, or a payment on the due
        // date would be found and then not advance anything.
        const latestDay = startOfUtcDay(latest.date).getTime();
        // Step forward one period per paid month, until the due date is beyond
        // the latest payment (or the plan is complete).
        while (startOfUtcDay(next).getTime() <= latestDay && guard++ < 120) {
          next = advanceDate(next, r.cadence as string);
          if (total != null) {
            paid = Math.min(paid + 1, total);
            if (paid >= total) {
              done = true;
              break;
            }
          }
        }

        if (!done && next.getTime() === dueDate.getTime()) continue; // no move
        await this.prisma.reminder.update({
          where: { id: r.id },
          data: {
            dueDate: next,
            installmentsPaid: total != null ? paid : undefined,
            done: done || undefined,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Reminder reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    if (input.accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: input.accountId, userId },
        select: { id: true },
      });
      if (!account) {
        throw new NotFoundException(
          `Account with id ${input.accountId} was not found`,
        );
      }
    }
    const isInstallment = input.installmentsTotal != null;
    return this.prisma.reminder.create({
      data: {
        userId,
        label: input.label,
        subcategoryId: input.subcategoryId ?? null,
        accountId: input.accountId ?? null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        dueAnchorDay: input.dueDate
          ? new Date(input.dueDate).getUTCDate()
          : null,
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
   * (a one-off with no cadence) is simply paid: it is marked done and kept, so
   * it stays on the list as a record of the payment — the same thing the
   * Telegram nudge's Paid button has always done with one.
   */
  async markPaid(userId: string, id: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!reminder) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }

    const plan = planSettlement(reminder);
    return this.prisma.reminder.update({
      where: { id },
      data: plan.kind === 'nothing-to-advance' ? { done: true } : plan.data,
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
      where: { id, userId, deletedAt: null },
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
  async scan(
    userId: string,
    since?: string,
  ): Promise<{ scanned: number; created: number }> {
    const from = since ? new Date(since) : null;
    const transactions = await this.prisma.transaction.findMany({
      where: {
        account: { userId },
        description: { not: null },
        // Skip anything that already produced a reminder — re-scan is additive.
        reminder: { is: null },
        ...(from ? { date: { gte: from } } : {}),
      },
      orderBy: { date: 'desc' },
      // With an explicit start date the user chose the range, so the cap only
      // guards the default "recent transactions" scan.
      take: from ? undefined : SCAN_WINDOW,
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        description: true,
        account: { select: { currency: true } },
        subcategory: { select: { id: true, name: true } },
        // An expense that already has a payback linked needs no chase-up.
        reimbursements: { select: { id: true }, take: 1 },
      },
    });

    let scanned = 0;
    let created = 0;

    // Categories that already have an open payment reminder — one reminder per
    // plan is enough; reconcile() keeps it advanced as later payments arrive, so
    // don't pile up a second. (Rows are newest-first, so the reminder anchors to
    // the most recent payment and older ones in the same plan are skipped.)
    const remindedSubs = new Set(
      (
        await this.prisma.reminder.findMany({
          where: {
            userId,
            done: false,
            kind: 'payment',
            subcategoryId: { not: null },
          },
          select: { subcategoryId: true },
        })
      ).map((r) => r.subcategoryId as string),
    );

    // Pass 1 — deterministic installments. The count and label come straight
    // from the row (its subcategory name), never from a model guess.
    const iouRows: typeof transactions = [];
    for (const t of transactions) {
      const desc = t.description as string;
      const inst = extractInstallment(desc);
      if (!inst) {
        if (looksLikeIou(desc)) {
          iouRows.push(t);
          continue;
        }
        // Deterministic: an expense still waiting on a refund. Only an expense
        // can be owed one (an income row saying "refund" is the refund), and
        // one that already has a payback linked is settled — nothing to chase.
        if (
          t.type === 'EXPENSE' &&
          t.reimbursements.length === 0 &&
          looksLikeExpectedRefund(desc)
        ) {
          scanned++;
          const madeOne = await this.createSafely({
            userId,
            label: refundLabel(desc),
            // Money owed to the user, so it lands with the IOUs and gets the
            // same "settle" action.
            kind: 'ask',
            amountCents: t.amount,
            currency: t.account.currency,
            note: 'Refund expected — link it to this expense once it arrives.',
            sourceTransactionId: t.id,
          });
          if (madeOne) created++;
        }
        continue;
      }
      // A fully-paid plan ("3/3") has nothing left to remind about.
      if (inst.paid >= inst.total) continue;
      const subId = t.subcategory?.id ?? null;
      if (subId && remindedSubs.has(subId)) continue; // plan already reminded
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
        // Lets reconcile() advance this plan as later payments are imported.
        subcategoryId: subId,
        sourceTransactionId: t.id,
      });
      if (madeOne) {
        created++;
        if (subId) remindedSubs.add(subId);
      }
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
      // Every scan/detect path lands here, so the schedule anchor is filled in
      // one place rather than at each call site.
      const dueDate = data.dueDate ? new Date(data.dueDate) : null;
      await this.prisma.reminder.create({
        data: {
          ...data,
          dueAnchorDay: data.dueAnchorDay ?? dueDate?.getUTCDate() ?? null,
        },
      });
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

  /** Deletes a reminder for good, as far as the user can tell — see planDeletion. */
  async remove(userId: string, id: string) {
    const plan = planDeletion(await this.assertOwn(userId, id), new Date());
    if (plan.kind === 'remove') {
      await this.prisma.reminder.delete({ where: { id } });
    } else {
      await this.prisma.reminder.update({ where: { id }, data: plan.data });
    }
  }

  private async assertOwn(userId: string, id: string) {
    const found = await this.prisma.reminder.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, sourceTransactionId: true },
    });
    if (!found) {
      throw new NotFoundException(`Reminder with id ${id} was not found`);
    }
    return found;
  }
}

/** Moves a date forward by one cadence period; unknown cadence → unchanged. */
