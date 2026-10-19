import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BASE_CURRENCY } from '../fx/fx';
import { PrismaService } from '../prisma.service';
import type { CreateFriendDTO } from './dtos/create-friend.dto';
import type { CreateSettlementDTO } from './dtos/create-settlement.dto';
import type { CreateSharedExpenseDTO } from './dtos/create-shared-expense.dto';
import {
  computeBalances,
  scopeWhere,
  type SplitScope,
  YOU,
} from './split-balances';
import { SplitGroupsService } from './split-groups.service';

type Participant = { friendId?: string; amountCents?: number };

@Injectable()
export class SplitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: SplitGroupsService,
  ) {}

  // ---- friends ----

  listFriends(userId: string) {
    return this.prisma.friend.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
  }

  async createFriend(userId: string, dto: CreateFriendDTO) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('A name is required');
    try {
      return await this.prisma.friend.create({ data: { userId, name } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('You already have a friend with that name');
      }
      throw err;
    }
  }

  async removeFriend(userId: string, id: string) {
    const friend = await this.prisma.friend.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!friend) {
      throw new NotFoundException(`Friend with id ${id} was not found`);
    }
    const [asPayer, asShare, asSettle] = await Promise.all([
      this.prisma.sharedExpense.count({ where: { userId, payerFriendId: id } }),
      this.prisma.sharedExpenseShare.count({
        where: { friendId: id, expense: { is: { userId } } },
      }),
      this.prisma.settlement.count({
        where: { userId, OR: [{ fromFriendId: id }, { toFriendId: id }] },
      }),
    ]);
    if (asPayer + asShare + asSettle > 0) {
      throw new ConflictException(
        'This friend still appears in shared expenses or settlements — remove those first.',
      );
    }
    await this.prisma.friend.delete({ where: { id } });
  }

  // ---- shared expenses ----

  async listExpenses(userId: string, scope: SplitScope = { kind: 'all' }) {
    if (scope.kind === 'group') await this.groups.assertGroup(userId, scope.id);
    return this.prisma.sharedExpense.findMany({
      where: { userId, ...scopeWhere(scope) },
      include: { shares: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createExpense(userId: string, dto: CreateSharedExpenseDTO) {
    await this.assertFriends(userId, [
      dto.payerFriendId,
      ...dto.participants.map((p) => p.friendId),
    ]);

    if (dto.groupId) await this.groups.assertGroup(userId, dto.groupId);

    const shares = computeShares(
      dto.splitMethod,
      dto.amountCents,
      dto.participants,
    );

    return this.prisma.$transaction(async (tx) => {
      if (dto.groupId) {
        await this.groups.ensureMembers(tx, dto.groupId, [
          dto.payerFriendId ?? null,
          ...shares.map((s) => s.friendId),
        ]);
      }
      return tx.sharedExpense.create({
        data: {
          userId,
          description: dto.description.trim(),
          amountCents: dto.amountCents,
          // BASE_CURRENCY, not the reporting preference: this is a stored
          // amount, and every stored amount in the app is anchored to the
          // ledger. Stamping the preference meant the label on a row recorded
          // which currency you happened to be *reading* in that week, while
          // balances() adds amountCents straight up without ever reading it —
          // so changing the preference silently re-denominated old rows.
          currency: BASE_CURRENCY,
          date: new Date(dto.date),
          payerFriendId: dto.payerFriendId ?? null,
          splitMethod: dto.splitMethod,
          groupId: dto.groupId ?? null,
          shares: {
            create: shares.map((s) => ({
              friendId: s.friendId,
              amountCents: s.amountCents,
            })),
          },
        },
        include: { shares: true },
      });
    });
  }

  /** Into a group, or out of every group with null. */
  async moveExpense(userId: string, id: string, groupId: string | null) {
    const expense = await this.prisma.sharedExpense.findFirst({
      where: { id, userId },
      include: { shares: { select: { friendId: true } } },
    });
    if (!expense) {
      throw new NotFoundException(`Shared expense with id ${id} was not found`);
    }
    if (groupId) await this.groups.assertGroup(userId, groupId);
    return this.prisma.$transaction(async (tx) => {
      if (groupId) {
        await this.groups.ensureMembers(tx, groupId, [
          expense.payerFriendId,
          ...expense.shares.map((s) => s.friendId),
        ]);
      }
      return tx.sharedExpense.update({
        where: { id },
        data: { groupId },
        include: { shares: true },
      });
    });
  }

  async removeExpense(userId: string, id: string) {
    const expense = await this.prisma.sharedExpense.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!expense) {
      throw new NotFoundException(`Shared expense with id ${id} was not found`);
    }
    // Shares cascade with the expense.
    await this.prisma.sharedExpense.delete({ where: { id } });
  }

  // ---- settlements ----

  async listSettlements(userId: string, scope: SplitScope = { kind: 'all' }) {
    if (scope.kind === 'group') await this.groups.assertGroup(userId, scope.id);
    return this.prisma.settlement.findMany({
      where: { userId, ...scopeWhere(scope) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createSettlement(userId: string, dto: CreateSettlementDTO) {
    if ((dto.fromFriendId ?? YOU) === (dto.toFriendId ?? YOU)) {
      throw new BadRequestException('A settlement needs two different people');
    }
    await this.assertFriends(userId, [dto.fromFriendId, dto.toFriendId]);
    if (dto.groupId) await this.groups.assertGroup(userId, dto.groupId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.groupId) {
        await this.groups.ensureMembers(tx, dto.groupId, [
          dto.fromFriendId ?? null,
          dto.toFriendId ?? null,
        ]);
      }
      return tx.settlement.create({
        data: {
          userId,
          fromFriendId: dto.fromFriendId ?? null,
          toFriendId: dto.toFriendId ?? null,
          amountCents: dto.amountCents,
          // Same anchor as createExpense.
          currency: BASE_CURRENCY,
          date: dto.date ? new Date(dto.date) : new Date(),
          note: dto.note?.trim() || null,
          groupId: dto.groupId ?? null,
        },
      });
    });
  }

  /** Into a group, or out of every group with null. */
  async moveSettlement(userId: string, id: string, groupId: string | null) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, userId },
    });
    if (!settlement) {
      throw new NotFoundException(`Settlement with id ${id} was not found`);
    }
    if (groupId) await this.groups.assertGroup(userId, groupId);
    return this.prisma.$transaction(async (tx) => {
      if (groupId) {
        await this.groups.ensureMembers(tx, groupId, [
          settlement.fromFriendId,
          settlement.toFriendId,
        ]);
      }
      return tx.settlement.update({ where: { id }, data: { groupId } });
    });
  }

  async removeSettlement(userId: string, id: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!settlement) {
      throw new NotFoundException(`Settlement with id ${id} was not found`);
    }
    await this.prisma.settlement.delete({ where: { id } });
  }

  // ---- balances ----

  /**
   * Net "who owes whom" in a scope: everything, what is not in a group, or one
   * group. The netting itself is computeBalances, shared with the group
   * summaries so a group's "settled" always agrees with its balances.
   */
  async balances(userId: string, scope: SplitScope = { kind: 'all' }) {
    if (scope.kind === 'group') await this.groups.assertGroup(userId, scope.id);
    const where = { userId, ...scopeWhere(scope) };
    const [friends, expenses, settlements] = await Promise.all([
      this.prisma.friend.findMany({
        where: { userId },
        select: { id: true, name: true },
      }),
      this.prisma.sharedExpense.findMany({
        where,
        select: {
          payerFriendId: true,
          shares: { select: { friendId: true, amountCents: true } },
        },
      }),
      this.prisma.settlement.findMany({
        where,
        select: { fromFriendId: true, toFriendId: true, amountCents: true },
      }),
    ]);

    // Labelled with what the summed cents actually are, not with the
    // preference: the netting adds amountCents directly, never converting.
    return {
      currency: BASE_CURRENCY,
      balances: computeBalances(friends, expenses, settlements),
    };
  }

  // ---- helpers ----

  /** Validates that every non-null friend id belongs to the user. */
  private async assertFriends(userId: string, ids: (string | undefined)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return;
    const found = await this.prisma.friend.count({
      where: { userId, id: { in: unique } },
    });
    if (found !== unique.length) {
      throw new BadRequestException(
        'This expense references an unknown friend',
      );
    }
  }
}

/**
 * Resolves each participant's share in cents. "exact" uses the given amounts
 * (which must sum to the total); "equal" splits the total evenly, handing the
 * rounding remainder to the first participants so the shares add up exactly.
 */
export function computeShares(
  splitMethod: 'equal' | 'exact',
  totalCents: number,
  participants: Participant[],
): { friendId: string | null; amountCents: number }[] {
  if (splitMethod === 'exact') {
    const shares = participants.map((p) => ({
      friendId: p.friendId ?? null,
      amountCents: p.amountCents ?? 0,
    }));
    if (shares.some((s) => s.amountCents < 0)) {
      throw new BadRequestException("Shares can't be negative");
    }
    const sum = shares.reduce((acc, s) => acc + s.amountCents, 0);
    if (sum !== totalCents) {
      throw new BadRequestException(
        `Exact shares must add up to the total (${totalCents}); got ${sum}`,
      );
    }
    return shares;
  }

  const n = participants.length;
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  return participants.map((p) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { friendId: p.friendId ?? null, amountCents: base + extra };
  });
}
