import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Budget, Prisma } from '@prisma/client';
import { periodBounds, periodLabel } from '../common/period';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import { displayAmountSql } from '../transactions/display-amount';
import type { CreateBudgetDTO } from './dtos/create-budget.dto';
import type { UpdateBudgetDTO } from './dtos/update-budget.dto';

const BUDGET_INCLUDE = {
  subcategory: { select: { id: true, name: true, category: true } },
} satisfies Prisma.BudgetInclude;

@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  /**
   * Budgets with spending progress for one financial month (default: the
   * current one). Each budget's *effective* limit for that month is its
   * per-month override if one exists, else the recurring `monthlyLimit`.
   */
  async list(userId: string, period?: string) {
    const { monthStartDay } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { monthStartDay: true },
    });
    const label = this.resolvePeriod(period, monthStartDay);
    // Budgets reset on the user's pay cycle, not on the 1st.
    const { start, end } = periodBounds(label, monthStartDay);
    const budgets = await this.prisma.budget.findMany({
      // Recurring budgets (oneOffPeriod null) show every month; a one-off shows
      // only in its own month.
      where: { userId, OR: [{ oneOffPeriod: null }, { oneOffPeriod: label }] },
      include: {
        ...BUDGET_INCLUDE,
        periods: { where: { period: label }, select: { limit: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    // Resolved once for the whole list. buildEntry used to fetch the user and
    // the display rate itself, so a screen with ten budgets asked for both ten
    // times over — and displayRate is not a cheap read, it can fetch a rate.
    const display = await this.displayFor(userId);
    return Promise.all(
      budgets.map((budget) =>
        this.buildEntry(userId, budget, label, start, end, display),
      ),
    );
  }

  /** The reporting currency and its rate — one lookup, shared by a whole list. */
  private async displayFor(userId: string) {
    const { baseCurrency } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { baseCurrency: true },
    });
    return this.fx.displayRate(userId, baseCurrency);
  }

  /** Sets (or replaces) the limit for one budget in one month. */
  async setPeriodLimit(
    userId: string,
    id: string,
    period: string,
    limit: number,
  ) {
    const { monthStartDay } = await this.assertOwn(userId, id);
    const label = this.resolvePeriod(period, monthStartDay);
    await this.prisma.budgetPeriod.upsert({
      where: { budgetId_period: { budgetId: id, period: label } },
      create: { budgetId: id, period: label, limit },
      update: { limit },
    });
    return this.entryFor(userId, id, label, monthStartDay);
  }

  /** Clears a month's override, so it falls back to the recurring limit. */
  async clearPeriodLimit(userId: string, id: string, period: string) {
    const { monthStartDay } = await this.assertOwn(userId, id);
    const label = this.resolvePeriod(period, monthStartDay);
    // deleteMany, not delete: a missing override is a no-op, not a 404.
    await this.prisma.budgetPeriod.deleteMany({
      where: { budgetId: id, period: label },
    });
    return this.entryFor(userId, id, label, monthStartDay);
  }

  /** Validates a "YYYY-MM" label, defaulting to the month containing today. */
  private resolvePeriod(period: string | undefined, monthStartDay: number) {
    if (period === undefined) return periodLabel(new Date(), monthStartDay);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new BadRequestException('period must be a "YYYY-MM" label');
    }
    return period;
  }

  /** Recomputes a single budget's progress for a month (post-mutation view). */
  private async entryFor(
    userId: string,
    id: string,
    label: string,
    monthStartDay: number,
  ) {
    const budget = await this.prisma.budget.findFirstOrThrow({
      where: { id, userId },
      include: {
        ...BUDGET_INCLUDE,
        periods: { where: { period: label }, select: { limit: true } },
      },
    });
    const { start, end } = periodBounds(label, monthStartDay);
    return this.buildEntry(
      userId,
      budget,
      label,
      start,
      end,
      await this.displayFor(userId),
    );
  }

  private async buildEntry(
    userId: string,
    budget: Prisma.BudgetGetPayload<{
      include: typeof BUDGET_INCLUDE & {
        periods: { select: { limit: true } };
      };
    }>,
    period: string,
    start: Date,
    end: Date,
    display: Awaited<ReturnType<FxService['displayRate']>>,
  ) {
    const override = budget.periods[0]?.limit ?? null;
    const storedLimit = override ?? budget.monthlyLimit;
    const { periods: _periods, ...rest } = budget;
    // Presented in the reporting currency, like every other total. Limits are
    // stored in the base currency and converted here rather than on the way in,
    // so the commitment itself never moves — only how it is shown. percent and
    // overBudget are ratios and come out the same either way.
    const spentCents = await this.computeSpent(
      userId,
      budget,
      start,
      end,
      display,
    );
    // The limit has no account behind it — it is a figure you typed — so it can
    // only convert at the one rate.
    const limit = Math.round(storedLimit * display.rate);
    return {
      ...rest,
      period,
      // Effective limit for this month; monthlyLimit stays the recurring base.
      limit,
      monthlyLimit: Math.round(budget.monthlyLimit * display.rate),
      isOverride: override !== null,
      spentCents,
      remainingCents: limit - spentCents,
      // Computed from what is on screen, so the bar always matches the two
      // numbers beside it. Once part of the spending is in another currency the
      // ratio genuinely does depend on the rate; pretending otherwise would put
      // a percentage next to figures that do not produce it.
      percent: limit > 0 ? spentCents / limit : 0,
      overBudget: spentCents > limit,
    };
  }

  async create(userId: string, dto: CreateBudgetDTO) {
    const hasSub = dto.subcategoryId != null;
    const hasCat = dto.category != null;
    if (hasSub === hasCat) {
      throw new BadRequestException(
        'A budget must target exactly one of subcategoryId or category',
      );
    }

    // Budgets cover variable spending only: the Expenses category (Bills,
    // Subscriptions, Debts and Savings are fixed/exact and tracked elsewhere).
    if (hasCat && dto.category !== 'Expenses') {
      throw new BadRequestException(
        'Budgets can only target the Expenses category',
      );
    }

    if (hasSub) {
      const subcategory = await this.prisma.subcategory.findFirst({
        where: { id: dto.subcategoryId, userId },
      });
      if (!subcategory) {
        throw new NotFoundException(
          `Subcategory with id ${dto.subcategoryId} was not found`,
        );
      }
      if (subcategory.category !== 'Expenses') {
        throw new BadRequestException(
          'Budgets can only target the Expenses category',
        );
      }
      // Only for new budgets: an existing one whose category is later retired
      // keeps working, so archiving never invalidates something already set up.
      if (subcategory.archivedAt) {
        throw new BadRequestException(
          `"${subcategory.name}" is archived — bring it back before budgeting for it`,
        );
      }
    }

    const scope: Prisma.BudgetWhereInput = hasSub
      ? { subcategoryId: dto.subcategoryId }
      : { category: dto.category };
    const existing = await this.prisma.budget.findFirst({
      where: { userId, ...scope },
    });
    if (existing) {
      throw new ConflictException('A budget for this scope already exists');
    }

    try {
      return await this.prisma.budget.create({
        data: {
          userId,
          monthlyLimit: dto.monthlyLimit,
          subcategoryId: dto.subcategoryId ?? null,
          category: dto.category ?? null,
          oneOffPeriod: dto.oneOffPeriod ?? null,
        },
        include: BUDGET_INCLUDE,
      });
    } catch (err) {
      // The DB uniques are the real guard; the findFirst above only provides
      // the friendly message. Map a constraint race to the same 409.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A budget for this scope already exists');
      }
      throw err;
    }
  }

  async update(userId: string, id: string, dto: UpdateBudgetDTO) {
    await this.assertOwn(userId, id);
    return this.prisma.budget.update({
      where: { id },
      data: { monthlyLimit: dto.monthlyLimit },
      include: BUDGET_INCLUDE,
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwn(userId, id);
    await this.prisma.budget.delete({ where: { id } });
  }

  /** Deletes every budget the user has (all months). */
  async removeAll(userId: string): Promise<{ deleted: number }> {
    const { count } = await this.prisma.budget.deleteMany({
      where: { userId },
    });
    return { deleted: count };
  }

  /**
   * Clears one financial month across all budgets: reverts every per-month
   * override for it (recurring budgets fall back to their default) and deletes
   * the one-off budgets that live only in that month. Recurring budgets
   * themselves are left intact — they apply to every month by design.
   */
  async clearMonth(
    userId: string,
    period: string,
  ): Promise<{
    period: string;
    clearedOverrides: number;
    deletedOneOffs: number;
  }> {
    const { monthStartDay } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { monthStartDay: true },
    });
    const label = this.resolvePeriod(period, monthStartDay);
    const [overrides, oneOffs] = await this.prisma.$transaction([
      this.prisma.budgetPeriod.deleteMany({
        where: { period: label, budget: { userId } },
      }),
      this.prisma.budget.deleteMany({ where: { userId, oneOffPeriod: label } }),
    ]);
    return {
      period: label,
      clearedOverrides: overrides.count,
      deletedOneOffs: oneOffs.count,
    };
  }

  /**
   * Spending in the budget's scope for the month, net of reimbursements linked
   * to those expenses (same definition as the dashboard's category spending).
   *
   * One query, with the dashboard's own per-row conversion (displayAmountSql):
   * this used to sum the converted part first and round once, so with two or
   * more rows in another currency the budget card and the spending card could
   * disagree by a cent about the same month.
   */
  private async computeSpent(
    userId: string,
    budget: Budget,
    start: Date,
    end: Date,
    display: { currency: string; rate: number },
  ): Promise<number> {
    const amount = displayAmountSql(display);
    // A budget always has exactly one scope set (enforced on create).
    const inScope = (row: Prisma.Sql) =>
      budget.subcategoryId
        ? Prisma.sql`${row}."subcategoryId" = ${budget.subcategoryId}`
        : Prisma.sql`EXISTS (
            SELECT 1 FROM "Subcategory" s
            WHERE s."id" = ${row}."subcategoryId"
              AND s."category"::text = ${budget.category}
          )`;

    // Internal moves are excluded — a transfer through a budgeted category is
    // not spending against it. A payback only nets when its parent actually
    // counts as spending: an internal parent is excluded, so its reimbursement
    // must be too (else it would show as a phantom credit against the budget).
    // The parent's date also decides the period: a payback belongs to the month
    // of the expense it cancels, otherwise that month stays overstated and a
    // later month picks up a credit for spending it never had.
    const [row] = await this.prisma.$queryRaw<{ spent: number }[]>`
      SELECT (
        COALESCE((
          SELECT SUM(${amount})
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          WHERE a."userId" = ${userId}
            AND t."type" = 'EXPENSE'
            AND t."excludeFromStats" = false
            AND t."date" >= ${start} AND t."date" < ${end}
            AND ${inScope(Prisma.sql`t`)}
        ), 0)
        - COALESCE((
          SELECT SUM(${amount})
          FROM "Transaction" t
          JOIN "Account" a ON a."id" = t."accountId"
          JOIN "Transaction" p ON p."id" = t."parentTransactionId"
          WHERE a."userId" = ${userId}
            AND t."type" = 'INCOME'
            AND t."excludeFromStats" = false
            AND p."excludeFromStats" = false
            AND p."date" >= ${start} AND p."date" < ${end}
            AND ${inScope(Prisma.sql`p`)}
        ), 0)
      )::int AS spent
    `;
    return row?.spent ?? 0;
  }

  private async assertOwn(
    userId: string,
    id: string,
  ): Promise<{ monthStartDay: number }> {
    const budget = await this.prisma.budget.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!budget) {
      throw new NotFoundException(`Budget with id ${id} was not found`);
    }
    const { monthStartDay } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { monthStartDay: true },
    });
    return { monthStartDay };
  }
}
