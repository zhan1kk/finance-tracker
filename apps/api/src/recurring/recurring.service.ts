import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, RecurringRule } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { TransactionCategory } from '../subcategories/types/subcategory.types';
import { nextOccurrence, occurrencesPerYear } from './cadence';
import type { CreateRecurringDTO } from './dtos/create-recurring.dto';
import type { UpdateRecurringDTO } from './dtos/update-recurring.dto';

/** Safety cap on catch-up occurrences generated in one run (e.g. after downtime). */
const MAX_CATCHUP = 366;

const RULE_INCLUDE = {
  account: { select: { id: true, name: true, currency: true } },
  subcategory: { select: { id: true, name: true, category: true } },
} satisfies Prisma.RecurringRuleInclude;

@Injectable()
export class RecurringService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const rules = await this.prisma.recurringRule.findMany({
      where: { userId },
      include: RULE_INCLUDE,
      orderBy: [{ active: 'desc' }, { nextRunAt: 'asc' }],
    });
    return rules.map((rule) => this.decorate(rule));
  }

  async create(userId: string, dto: CreateRecurringDTO) {
    const subcategory = await this.getOwnSubcategory(userId, dto.subcategoryId);
    await this.assertOwnAccount(userId, dto.accountId);
    this.ensureTypeMatches(dto.type, subcategory.category);

    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (endDate && endDate < startDate) {
      throw new BadRequestException('endDate cannot be before startDate');
    }

    const rule = await this.prisma.recurringRule.create({
      data: {
        userId,
        type: dto.type,
        amount: dto.amount,
        description: dto.description,
        accountId: dto.accountId,
        subcategoryId: dto.subcategoryId,
        cadence: dto.cadence,
        interval: dto.interval ?? 1,
        startDate,
        nextRunAt: startDate,
        endDate,
        maxOccurrences: dto.maxOccurrences,
      },
      include: RULE_INCLUDE,
    });
    return this.decorate(rule);
  }

  async update(userId: string, id: string, dto: UpdateRecurringDTO) {
    await this.assertOwnRule(userId, id);
    const rule = await this.prisma.recurringRule.update({
      where: { id },
      data: {
        amount: dto.amount,
        description: dto.description,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        maxOccurrences: dto.maxOccurrences,
        active: dto.active,
      },
      include: RULE_INCLUDE,
    });
    return this.decorate(rule);
  }

  async remove(userId: string, id: string) {
    await this.assertOwnRule(userId, id);
    await this.prisma.recurringRule.delete({ where: { id } });
  }

  /**
   * Posts every occurrence due at/before `now` for the matching active rules,
   * advancing each schedule and deactivating rules that hit their end date or
   * installment count. Each rule's occurrences + balance change + rule update
   * are written atomically. Optionally scoped to one user (manual trigger).
   */
  async runDue(now: Date, userId?: string) {
    const due = await this.prisma.recurringRule.findMany({
      where: { active: true, nextRunAt: { lte: now }, userId },
    });
    let transactionsCreated = 0;
    for (const rule of due) {
      transactionsCreated += await this.postRule(rule, now);
    }
    return { rulesProcessed: due.length, transactionsCreated };
  }

  private async postRule(rule: RecurringRule, now: Date): Promise<number> {
    const anchorDay = rule.startDate.getUTCDate();
    let nextRunAt = rule.nextRunAt;
    let occurrencesCreated = rule.occurrencesCreated;
    let active = true;
    let delta = 0;
    let guard = 0;
    const toCreate: Prisma.TransactionCreateManyInput[] = [];

    while (active && nextRunAt <= now && guard++ < MAX_CATCHUP) {
      if (rule.endDate && nextRunAt > rule.endDate) {
        active = false;
        break;
      }
      if (rule.maxOccurrences && occurrencesCreated >= rule.maxOccurrences) {
        active = false;
        break;
      }

      toCreate.push({
        type: rule.type,
        date: nextRunAt,
        amount: rule.amount,
        description: rule.description,
        accountId: rule.accountId,
        subcategoryId: rule.subcategoryId,
        recurringRuleId: rule.id,
      });
      delta += rule.type === 'INCOME' ? rule.amount : -rule.amount;
      occurrencesCreated += 1;
      nextRunAt = nextOccurrence(
        nextRunAt,
        rule.cadence,
        rule.interval,
        anchorDay,
      );

      if (rule.maxOccurrences && occurrencesCreated >= rule.maxOccurrences) {
        active = false;
      } else if (rule.endDate && nextRunAt > rule.endDate) {
        active = false;
      }
    }

    if (toCreate.length === 0) {
      if (active !== rule.active) {
        await this.prisma.recurringRule.update({
          where: { id: rule.id },
          data: { active },
        });
      }
      return 0;
    }

    // Advance the schedule first, guarded on the nextRunAt we read. If a
    // concurrent run (double-clicked "run now", or cron overlapping a manual
    // trigger) already advanced it, the guard matches 0 rows and we post
    // nothing — so occurrences can never be created twice.
    return this.prisma.$transaction(async (tx) => {
      const advanced = await tx.recurringRule.updateMany({
        where: { id: rule.id, nextRunAt: rule.nextRunAt, active: true },
        data: { nextRunAt, occurrencesCreated, active },
      });
      if (advanced.count === 0) {
        return 0;
      }
      await tx.transaction.createMany({ data: toCreate });
      await tx.account.update({
        where: { id: rule.accountId },
        data: { balance: { increment: delta } },
      });
      return toCreate.length;
    });
  }

  private decorate<T extends RecurringRule>(rule: T) {
    const perYear = occurrencesPerYear(rule.cadence, rule.interval);
    return {
      ...rule,
      annualizedCents: Math.round(rule.amount * perYear),
      progress:
        rule.maxOccurrences && rule.maxOccurrences > 0
          ? rule.occurrencesCreated / rule.maxOccurrences
          : null,
    };
  }

  private ensureTypeMatches(
    type: 'INCOME' | 'EXPENSE',
    category: TransactionCategory,
  ) {
    if (type === 'INCOME' && category !== 'Income') {
      throw new BadRequestException(
        'INCOME rules require a subcategory in the Income category',
      );
    }
    if (type === 'EXPENSE' && category === 'Income') {
      throw new BadRequestException(
        'EXPENSE rules cannot use an Income subcategory',
      );
    }
  }

  private async assertOwnAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException(`Account with id ${accountId} was not found`);
    }
  }

  private async getOwnSubcategory(userId: string, subcategoryId: string) {
    const subcategory = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId },
    });
    if (!subcategory) {
      throw new NotFoundException(
        `Subcategory with id ${subcategoryId} was not found`,
      );
    }
    return subcategory;
  }

  private async assertOwnRule(userId: string, id: string) {
    const rule = await this.prisma.recurringRule.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!rule) {
      throw new NotFoundException(`Recurring rule with id ${id} was not found`);
    }
  }
}
