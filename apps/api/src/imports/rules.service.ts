import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export type RuleMatch = { subcategoryId: string; ruleId: string };

@Injectable()
export class RulesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.categorizationRule.findMany({
      where: { userId },
      include: { subcategory: { select: { id: true, name: true } } },
      orderBy: { pattern: 'asc' },
    });
  }

  async create(
    userId: string,
    input: { pattern: string; subcategoryId: string },
  ) {
    const pattern = normalizePattern(input.pattern);
    if (pattern === '') {
      throw new ConflictException('Rule pattern cannot be empty');
    }
    await this.assertOwnSubcategory(userId, input.subcategoryId);

    const existing = await this.prisma.categorizationRule.findUnique({
      where: { userId_pattern: { userId, pattern } },
    });
    if (existing) {
      throw new ConflictException(`A rule for "${pattern}" already exists`);
    }

    return this.prisma.categorizationRule.create({
      data: {
        userId,
        pattern,
        subcategoryId: input.subcategoryId,
        source: 'MANUAL',
      },
    });
  }

  async update(userId: string, id: string, input: { subcategoryId?: string }) {
    await this.assertOwnRule(userId, id);
    if (input.subcategoryId) {
      await this.assertOwnSubcategory(userId, input.subcategoryId);
    }
    return this.prisma.categorizationRule.update({
      where: { id },
      data: { subcategoryId: input.subcategoryId },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnRule(userId, id);
    await this.prisma.categorizationRule.delete({ where: { id } });
  }

  /**
   * Best rule for a normalized description: the longest pattern that is a
   * substring of it (most specific wins). Pure read — hit counts are bumped on
   * commit, not on preview.
   */
  match(
    rules: { id: string; pattern: string; subcategoryId: string }[],
    normalizedDescription: string,
  ): RuleMatch | null {
    let best: { id: string; pattern: string; subcategoryId: string } | null =
      null;
    for (const rule of rules) {
      if (!normalizedDescription.includes(rule.pattern)) continue;
      if (!best || rule.pattern.length > best.pattern.length) {
        best = rule;
      }
    }
    return best ? { subcategoryId: best.subcategoryId, ruleId: best.id } : null;
  }

  /**
   * Learns a rule from a human correction (upsert by normalized pattern), run
   * inside the commit transaction. Pattern is the row's normalized merchant.
   */
  learnFromCorrection(
    tx: Prisma.TransactionClient,
    userId: string,
    pattern: string,
    subcategoryId: string,
  ) {
    const normalized = normalizePattern(pattern);
    if (normalized === '') return Promise.resolve(null);
    return tx.categorizationRule.upsert({
      where: { userId_pattern: { userId, pattern: normalized } },
      create: {
        userId,
        pattern: normalized,
        subcategoryId,
        source: 'MANUAL',
        hitCount: 1,
      },
      update: { subcategoryId, hitCount: { increment: 1 } },
    });
  }

  private async assertOwnSubcategory(userId: string, subcategoryId: string) {
    const found = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(
        `Subcategory with id ${subcategoryId} was not found`,
      );
    }
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

/** Lowercased, whitespace-collapsed pattern used for matching and uniqueness. */
export function normalizePattern(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}
