import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Budget, Prisma } from '@prisma/client';
import { periodBounds, periodLabel } from '../common/period';
import { PrismaService } from '../prisma.service';
import type { CreateBudgetDTO } from './dtos/create-budget.dto';
import type { UpdateBudgetDTO } from './dtos/update-budget.dto';

const BUDGET_INCLUDE = {
  subcategory: { select: { id: true, name: true, category: true } },
} satisfies Prisma.BudgetInclude;

@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService) {}

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
    return Promise.all(
      budgets.map((budget) =>
        this.buildEntry(userId, budget, label, start, end),
      ),
    );
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
    return this.buildEntry(userId, budget, label, start, end);
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
  ) {
    const override = budget.periods[0]?.limit ?? null;
    const limit = override ?? budget.monthlyLimit;
    const spentCents = await this.computeSpent(userId, budget, start, end);
    const { periods: _periods, ...rest } = budget;
    return {
      ...rest,
      period,
      // Effective limit for this month; monthlyLimit stays the recurring base.
      limit,
      isOverride: override !== null,
      spentCents,
      remainingCents: limit - spentCents,
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
   */
  private async computeSpent(
    userId: string,
    budget: Budget,
    start: Date,
    end: Date,
  ): Promise<number> {
    const date = { gte: start, lt: end };
    const owner = { account: { userId } };

    // A budget always has exactly one scope set (enforced on create).
    const category = budget.category ?? undefined;
    const expenseScope: Prisma.TransactionWhereInput = budget.subcategoryId
      ? { subcategoryId: budget.subcategoryId }
      : { subcategory: { is: { category } } };
    // A payback only nets when its parent actually counts as spending — an
    // internal parent is excluded, so its reimbursement must be too (else it
    // would show as a phantom credit against the budget).
    // The parent's date also decides the period: a payback belongs to the month
    // of the expense it cancels, otherwise that month stays overstated and a
    // later month picks up a credit for spending it never had.
    const reimbScope: Prisma.TransactionWhereInput = budget.subcategoryId
      ? {
          parentTransaction: {
            is: {
              subcategoryId: budget.subcategoryId,
              excludeFromStats: false,
              date,
            },
          },
        }
      : {
          parentTransaction: {
            is: {
              subcategory: { is: { category } },
              excludeFromStats: false,
              date,
            },
          },
        };

    // Budgets are set in the base currency, so spending is summed in base too.
    // Internal moves are excluded — a transfer through a budgeted category is
    // not spending against it.
    const [expense, reimbursed] = await Promise.all([
      this.prisma.transaction.aggregate({
        _sum: { amountBase: true },
        where: {
          ...owner,
          type: 'EXPENSE',
          excludeFromStats: false,
          date,
          ...expenseScope,
        },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amountBase: true },
        where: {
          ...owner,
          type: 'INCOME',
          excludeFromStats: false,
          parentTransactionId: { not: null },
          // No date filter here on purpose: the period is applied to the parent
          // expense inside reimbScope, so a payback that arrives in a later
          // month still nets against the month it belongs to.
          ...reimbScope,
        },
      }),
    ]);

    return (expense._sum.amountBase ?? 0) - (reimbursed._sum.amountBase ?? 0);
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
