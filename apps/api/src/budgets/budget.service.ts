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

  /** Budgets with the current financial month's spending progress. */
  async list(userId: string) {
    const [budgets, user] = await Promise.all([
      this.prisma.budget.findMany({
        where: { userId },
        include: BUDGET_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { monthStartDay: true },
      }),
    ]);
    // Budgets reset on the user's pay cycle, not on the 1st.
    const { start, end } = periodBounds(
      periodLabel(new Date(), user.monthStartDay),
      user.monthStartDay,
    );
    return Promise.all(
      budgets.map(async (budget) => {
        const spentCents = await this.computeSpent(userId, budget, start, end);
        return {
          ...budget,
          spentCents,
          remainingCents: budget.monthlyLimit - spentCents,
          percent:
            budget.monthlyLimit > 0 ? spentCents / budget.monthlyLimit : 0,
          overBudget: spentCents > budget.monthlyLimit,
        };
      }),
    );
  }

  async create(userId: string, dto: CreateBudgetDTO) {
    const hasSub = dto.subcategoryId != null;
    const hasCat = dto.category != null;
    if (hasSub === hasCat) {
      throw new BadRequestException(
        'A budget must target exactly one of subcategoryId or category',
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
      if (subcategory.category === 'Income') {
        throw new BadRequestException('Income is not a spending category');
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
    const reimbScope: Prisma.TransactionWhereInput = budget.subcategoryId
      ? { parentTransaction: { is: { subcategoryId: budget.subcategoryId } } }
      : {
          parentTransaction: {
            is: { subcategory: { is: { category } } },
          },
        };

    // Budgets are set in the base currency, so spending is summed in base too.
    const [expense, reimbursed] = await Promise.all([
      this.prisma.transaction.aggregate({
        _sum: { amountBase: true },
        where: { ...owner, type: 'EXPENSE', date, ...expenseScope },
      }),
      this.prisma.transaction.aggregate({
        _sum: { amountBase: true },
        where: {
          ...owner,
          type: 'INCOME',
          parentTransactionId: { not: null },
          date,
          ...reimbScope,
        },
      }),
    ]);

    return (expense._sum.amountBase ?? 0) - (reimbursed._sum.amountBase ?? 0);
  }

  private async assertOwn(userId: string, id: string) {
    const budget = await this.prisma.budget.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!budget) {
      throw new NotFoundException(`Budget with id ${id} was not found`);
    }
  }
}

