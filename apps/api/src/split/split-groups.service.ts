import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BASE_CURRENCY } from '../fx/fx';
import { PrismaService } from '../prisma.service';
import type { CreateSplitGroupDTO } from './dtos/split-group.dto';
import {
  computeBalances,
  type ExpenseLite,
  type SettlementLite,
  yourPosition,
} from './split-balances';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Groups of the split ledger: a trip, a flat, a dinner club.
 *
 * Modelled on how Splitwise and Settle Up treat a finished group — it is put
 * away, not deleted: a group whose balances net to nothing moves out of the
 * overview into a folded "settled" list, and opens again from there. Nothing is
 * stored to mark it settled. It is settled while its own balances are zero, so
 * an expense added later reopens it without anyone having to remember to.
 */
@Injectable()
export class SplitGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const [groups, friends, expenses, settlements] = await Promise.all([
      this.prisma.splitGroup.findMany({
        where: { userId },
        include: {
          members: {
            include: { friend: { select: { id: true, name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.friend.findMany({
        where: { userId },
        select: { id: true, name: true },
      }),
      this.prisma.sharedExpense.findMany({
        where: { userId, groupId: { not: null } },
        select: {
          groupId: true,
          date: true,
          payerFriendId: true,
          shares: { select: { friendId: true, amountCents: true } },
        },
      }),
      this.prisma.settlement.findMany({
        where: { userId, groupId: { not: null } },
        select: {
          groupId: true,
          date: true,
          fromFriendId: true,
          toFriendId: true,
          amountCents: true,
        },
      }),
    ]);

    const summaries = groups.map((g) =>
      summarize(
        g,
        friends,
        expenses.filter((e) => e.groupId === g.id),
        settlements.filter((s) => s.groupId === g.id),
      ),
    );
    // Open groups first, most recently active first; settled ones after.
    const recency = (s: (typeof summaries)[number]) =>
      (s.lastActivity ?? s.createdAt).getTime();
    return summaries.sort(
      (a, b) =>
        Number(a.settled) - Number(b.settled) || recency(b) - recency(a),
    );
  }

  async get(userId: string, id: string) {
    const summary = (await this.list(userId)).find((g) => g.id === id);
    if (!summary) {
      throw new NotFoundException(`Group with id ${id} was not found`);
    }
    return summary;
  }

  async create(userId: string, dto: CreateSplitGroupDTO) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('A name is required');
    const memberIds = [...new Set(dto.memberIds ?? [])];
    await this.assertFriends(userId, memberIds);
    try {
      const group = await this.prisma.splitGroup.create({
        data: {
          userId,
          name,
          members: { create: memberIds.map((friendId) => ({ friendId })) },
        },
      });
      return this.get(userId, group.id);
    } catch (err) {
      throw nameTaken(err) ?? err;
    }
  }

  async rename(userId: string, id: string, rawName: string) {
    await this.assertGroup(userId, id);
    const name = rawName.trim();
    if (!name) throw new BadRequestException('A name is required');
    try {
      await this.prisma.splitGroup.update({ where: { id }, data: { name } });
    } catch (err) {
      throw nameTaken(err) ?? err;
    }
    return this.get(userId, id);
  }

  /**
   * Only an empty group can go. Its expenses are money people owe each other;
   * deleting the group with them would erase debts, and dropping them out of
   * it would quietly move them somewhere they were never put. A settled group
   * does not need deleting — it is already out of the way.
   */
  async remove(userId: string, id: string) {
    await this.assertGroup(userId, id);
    const [expenses, settlements] = await Promise.all([
      this.prisma.sharedExpense.count({ where: { userId, groupId: id } }),
      this.prisma.settlement.count({ where: { userId, groupId: id } }),
    ]);
    if (expenses + settlements > 0) {
      throw new ConflictException(
        `Cannot delete this group: it has ${expenses} expense(s) and ${settlements} settlement(s). Delete them or move them out of the group first.`,
      );
    }
    await this.prisma.splitGroup.delete({ where: { id } });
  }

  async addMember(userId: string, groupId: string, friendId: string) {
    await this.assertGroup(userId, groupId);
    await this.assertFriends(userId, [friendId]);
    await this.ensureMembers(this.prisma, groupId, [friendId]);
    return this.get(userId, groupId);
  }

  /** Refused while they still appear in the group's money, like friends are. */
  async removeMember(userId: string, groupId: string, friendId: string) {
    await this.assertGroup(userId, groupId);
    const [asPayer, asShare, asSettle] = await Promise.all([
      this.prisma.sharedExpense.count({
        where: { userId, groupId, payerFriendId: friendId },
      }),
      this.prisma.sharedExpenseShare.count({
        where: { friendId, expense: { is: { userId, groupId } } },
      }),
      this.prisma.settlement.count({
        where: {
          userId,
          groupId,
          OR: [{ fromFriendId: friendId }, { toFriendId: friendId }],
        },
      }),
    ]);
    if (asPayer + asShare + asSettle > 0) {
      throw new ConflictException(
        'They still appear in this group’s expenses or settlements — remove those first.',
      );
    }
    await this.prisma.splitGroupMember.deleteMany({
      where: { groupId, friendId },
    });
    return this.get(userId, groupId);
  }

  /** 404 unless the group exists and is the user's. */
  async assertGroup(userId: string, id: string) {
    const group = await this.prisma.splitGroup.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!group) {
      throw new NotFoundException(`Group with id ${id} was not found`);
    }
  }

  /**
   * Adds whoever is missing. Called whenever money enters a group, so its
   * member list is never short of someone who owes or is owed in it.
   */
  async ensureMembers(db: Db, groupId: string, friendIds: (string | null)[]) {
    const ids = [...new Set(friendIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    await db.splitGroupMember.createMany({
      data: ids.map((friendId) => ({ groupId, friendId })),
      skipDuplicates: true,
    });
  }

  private async assertFriends(userId: string, ids: string[]) {
    if (ids.length === 0) return;
    const found = await this.prisma.friend.count({
      where: { userId, id: { in: ids } },
    });
    if (found !== ids.length) {
      throw new BadRequestException('This group references an unknown friend');
    }
  }
}

function summarize(
  group: {
    id: string;
    name: string;
    createdAt: Date;
    members: { friend: { id: string; name: string } }[];
  },
  friends: { id: string; name: string }[],
  expenses: (ExpenseLite & { date: Date })[],
  settlements: (SettlementLite & { date: Date })[],
) {
  const balances = computeBalances(friends, expenses, settlements);
  const dates = [...expenses, ...settlements].map((x) => x.date.getTime());
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    members: group.members
      .map((m) => m.friend)
      .sort((a, b) => a.name.localeCompare(b.name)),
    expenseCount: expenses.length,
    settlementCount: settlements.length,
    lastActivity: dates.length > 0 ? new Date(Math.max(...dates)) : null,
    // Same anchor as SplitService.balances: stored amounts are ledger amounts.
    currency: BASE_CURRENCY,
    balances,
    ...yourPosition(balances),
    // An empty group is not settled — it has not started.
    settled: expenses.length > 0 && balances.length === 0,
  };
}

function nameTaken(err: unknown): ConflictException | null {
  return err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
    ? new ConflictException('You already have a group with that name')
    : null;
}
