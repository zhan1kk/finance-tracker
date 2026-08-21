import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { normalizeMerchant } from './normalization';

/** A rule assigns a subcategory, a transfer counter account, or marks internal. */
export type RuleTarget =
  | {
      subcategoryId: string;
      counterAccountId?: never;
      excludeFromStats?: never;
    }
  | {
      counterAccountId: string;
      subcategoryId?: never;
      excludeFromStats?: never;
    }
  | { excludeFromStats: true; subcategoryId?: never; counterAccountId?: never };

export type RuleMatch = RuleTarget & { ruleId: string };

type MatchableRule = {
  id: string;
  pattern: string;
  type: TransactionType;
  subcategoryId: string | null;
  counterAccountId: string | null;
  excludeFromStats: boolean;
};

@Injectable()
export class RulesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.categorizationRule.findMany({
      where: { userId },
      include: {
        subcategory: { select: { id: true, name: true } },
        counterAccount: { select: { id: true, name: true } },
      },
      orderBy: { pattern: 'asc' },
    });
  }

  async create(
    userId: string,
    input: {
      pattern: string;
      subcategoryId?: string | null;
      counterAccountId?: string | null;
    },
  ) {
    const pattern = normalizePattern(input.pattern);
    if (pattern === '') {
      throw new ConflictException('Rule pattern cannot be empty');
    }
    const { target, type } = await this.resolveTarget(userId, input);

    const existing = await this.prisma.categorizationRule.findUnique({
      where: { userId_pattern_type: { userId, pattern, type } },
    });
    if (existing) {
      throw new ConflictException(`A rule for "${pattern}" already exists`);
    }

    return this.prisma.categorizationRule.create({
      data: {
        userId,
        pattern,
        type,
        subcategoryId: target.subcategoryId ?? null,
        counterAccountId: target.counterAccountId ?? null,
        source: 'MANUAL',
      },
    });
  }

  async update(
    userId: string,
    id: string,
    input: { subcategoryId?: string | null; counterAccountId?: string | null },
  ) {
    await this.assertOwnRule(userId, id);
    // Retargeting always replaces the other side, so a rule never ends up with
    // both a subcategory and a counter account. The direction follows the new
    // target for the same reason it is derived on create.
    const { target, type } = await this.resolveTarget(userId, input);
    return this.prisma.categorizationRule.update({
      where: { id },
      data: {
        type,
        subcategoryId: target.subcategoryId ?? null,
        counterAccountId: target.counterAccountId ?? null,
      },
    });
  }

  /**
   * Validates that exactly one target is given and that the user owns it, and
   * derives the rule's direction from the target: transfer rules match either
   * sign (money moves both ways past the same counterparty name), subcategory
   * rules only rows of their subcategory's direction. Never user-supplied.
   */
  private async resolveTarget(
    userId: string,
    input: { subcategoryId?: string | null; counterAccountId?: string | null },
  ): Promise<{ target: RuleTarget; type: TransactionType }> {
    const hasSub = Boolean(input.subcategoryId);
    const hasAccount = Boolean(input.counterAccountId);
    if (hasSub === hasAccount) {
      throw new ConflictException(
        'A rule must target exactly one of a subcategory or a transfer account',
      );
    }
    if (hasSub) {
      const subcategory = await this.getOwnSubcategory(
        userId,
        input.subcategoryId as string,
      );
      return {
        target: { subcategoryId: subcategory.id },
        type: subcategory.category === 'Income' ? 'INCOME' : 'EXPENSE',
      };
    }
    await this.assertOwnAccount(userId, input.counterAccountId as string);
    return {
      target: { counterAccountId: input.counterAccountId as string },
      type: 'TRANSFER',
    };
  }

  private async assertOwnAccount(userId: string, accountId: string) {
    const found = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(`Account with id ${accountId} was not found`);
    }
  }

  async remove(userId: string, id: string) {
    await this.assertOwnRule(userId, id);
    await this.prisma.categorizationRule.delete({ where: { id } });
  }

  /**
   * Best rule for a row: the longest pattern that is a substring of the
   * normalized description (most specific wins) among rules that apply to the
   * row's direction — INCOME/EXPENSE rules only match their own sign, TRANSFER
   * rules match either. Pure read — hit counts are bumped on commit, not on
   * preview.
   */
  match(
    rules: MatchableRule[],
    normalizedDescription: string,
    rowType: TransactionType,
  ): RuleMatch | null {
    let best: MatchableRule | null = null;
    for (const rule of rules) {
      if (rule.type !== 'TRANSFER' && rule.type !== rowType) continue;
      if (!normalizedDescription.includes(rule.pattern)) continue;
      if (!best || rule.pattern.length > best.pattern.length) {
        best = rule;
      }
    }
    if (!best) return null;
    if (best.excludeFromStats) {
      return { excludeFromStats: true, ruleId: best.id };
    }
    return best.counterAccountId
      ? { counterAccountId: best.counterAccountId, ruleId: best.id }
      : { subcategoryId: best.subcategoryId as string, ruleId: best.id };
  }

  /**
   * Learns a rule from a human correction (upsert by normalized pattern +
   * direction), run inside the commit transaction. Pattern is the row's
   * normalized merchant; keying on the row's direction lets the same merchant
   * carry different meanings by sign (Amazon charge → shopping, Amazon credit
   * → refund) without the corrections overwriting each other.
   */
  learnFromCorrection(
    tx: Prisma.TransactionClient,
    userId: string,
    pattern: string,
    target: RuleTarget,
    rowType: TransactionType,
  ) {
    const normalized = normalizePattern(pattern);
    if (normalized === '') return Promise.resolve(null);
    const subcategoryId = target.subcategoryId ?? null;
    const counterAccountId = target.counterAccountId ?? null;
    const excludeFromStats = target.excludeFromStats ?? false;
    // Internal rules key on the row's own direction (like subcategory rules):
    // "Receipt from your account" is always an inflow, "Transfer to your
    // account" an outflow, so each side learns its own pattern.
    const type: TransactionType = counterAccountId ? 'TRANSFER' : rowType;
    return tx.categorizationRule.upsert({
      where: { userId_pattern_type: { userId, pattern: normalized, type } },
      create: {
        userId,
        pattern: normalized,
        type,
        subcategoryId,
        counterAccountId,
        excludeFromStats,
        source: 'MANUAL',
        hitCount: 1,
      },
      update: {
        subcategoryId,
        counterAccountId,
        excludeFromStats,
        hitCount: { increment: 1 },
      },
    });
  }

  private async getOwnSubcategory(userId: string, subcategoryId: string) {
    const found = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId },
      select: { id: true, category: true },
    });
    if (!found) {
      throw new NotFoundException(
        `Subcategory with id ${subcategoryId} was not found`,
      );
    }
    return found;
  }

  private async assertOwnRule(userId: string, id: string) {
    const found = await this.prisma.categorizationRule.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(`Rule with id ${id} was not found`);
    }
  }
}

/**
 * A rule pattern is matched (as a substring) against a row's *normalized*
 * merchant, so it must be reduced the exact same way — otherwise a user-typed
 * "Transfer from MARIA SANTOS" keeps the noise word "transfer" that the
 * description drops, and could never match. Reusing normalizeMerchant keeps
 * patterns and descriptions in one vocabulary. Idempotent, so re-normalizing an
 * already-normalized learned pattern is a no-op.
 */
export function normalizePattern(raw: string): string {
  return normalizeMerchant(raw);
}
