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

/** The key used for the user themselves in the debt graph (null friend id). */
const YOU = 'you';

type Participant = { friendId?: string; amountCents?: number };

@Injectable()
export class SplitService {
  constructor(private readonly prisma: PrismaService) {}

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

  listExpenses(userId: string) {
    return this.prisma.sharedExpense.findMany({
      where: { userId },
      include: { shares: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createExpense(userId: string, dto: CreateSharedExpenseDTO) {
    await this.assertFriends(userId, [
      dto.payerFriendId,
      ...dto.participants.map((p) => p.friendId),
    ]);

    const shares = computeShares(
      dto.splitMethod,
      dto.amountCents,
      dto.participants,
    );

    return this.prisma.sharedExpense.create({
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
        shares: {
          create: shares.map((s) => ({
            friendId: s.friendId,
            amountCents: s.amountCents,
          })),
        },
      },
      include: { shares: true },
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

  listSettlements(userId: string) {
    return this.prisma.settlement.findMany({
      where: { userId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createSettlement(userId: string, dto: CreateSettlementDTO) {
    if ((dto.fromFriendId ?? YOU) === (dto.toFriendId ?? YOU)) {
      throw new BadRequestException('A settlement needs two different people');
    }
    await this.assertFriends(userId, [dto.fromFriendId, dto.toFriendId]);
    return this.prisma.settlement.create({
      data: {
        userId,
        fromFriendId: dto.fromFriendId ?? null,
        toFriendId: dto.toFriendId ?? null,
        amountCents: dto.amountCents,
        // Same anchor as createExpense.
        currency: BASE_CURRENCY,
        date: dto.date ? new Date(dto.date) : new Date(),
        note: dto.note?.trim() || null,
      },
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
   * Net "who owes whom" across everyone. Each expense adds a debt from each
   * participant (other than the payer) to the payer; each settlement pays a debt
   * down. Nets each unordered pair to a single direction, and lists only the
   * non-zero ones — those involving You first.
   */
  async balances(userId: string) {
    const [friends, expenses, settlements] = await Promise.all([
      this.prisma.friend.findMany({
        where: { userId },
        select: { id: true, name: true },
      }),
      this.prisma.sharedExpense.findMany({
        where: { userId },
        select: {
          payerFriendId: true,
          shares: { select: { friendId: true, amountCents: true } },
        },
      }),
      this.prisma.settlement.findMany({
        where: { userId },
        select: { fromFriendId: true, toFriendId: true, amountCents: true },
      }),
    ]);

    // owe.get(`${from}|${to}`) = how much `from` owes `to`.
    const owe = new Map<string, number>();
    const add = (from: string, to: string, amount: number) => {
      if (from === to || amount === 0) return;
      const key = `${from}|${to}`;
      owe.set(key, (owe.get(key) ?? 0) + amount);
    };
    for (const e of expenses) {
      const payer = e.payerFriendId ?? YOU;
      for (const s of e.shares) {
        const party = s.friendId ?? YOU;
        if (party !== payer) add(party, payer, s.amountCents);
      }
    }
    for (const st of settlements) {
      add(st.fromFriendId ?? YOU, st.toFriendId ?? YOU, -st.amountCents);
    }

    const nameOf = new Map(friends.map((f) => [f.id, f.name]));
    const label = (key: string) =>
      key === YOU ? 'You' : (nameOf.get(key) ?? '(removed)');
    const idOf = (key: string) => (key === YOU ? null : key);

    const parties = [YOU, ...friends.map((f) => f.id)];
    const seen = new Set<string>();
    const balances: {
      fromId: string | null;
      fromName: string;
      toId: string | null;
      toName: string;
      amountCents: number;
    }[] = [];
    for (const a of parties) {
      for (const b of parties) {
        if (a === b) continue;
        const pair = [a, b].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const net = (owe.get(`${a}|${b}`) ?? 0) - (owe.get(`${b}|${a}`) ?? 0);
        if (net > 0) {
          balances.push({
            fromId: idOf(a),
            fromName: label(a),
            toId: idOf(b),
            toName: label(b),
            amountCents: net,
          });
        } else if (net < 0) {
          balances.push({
            fromId: idOf(b),
            fromName: label(b),
            toId: idOf(a),
            toName: label(a),
            amountCents: -net,
          });
        }
      }
    }
    // Balances involving You first, then largest amounts.
    balances.sort((x, y) => {
      const xYou = x.fromId === null || x.toId === null ? 0 : 1;
      const yYou = y.fromId === null || y.toId === null ? 0 : 1;
      return xYou - yYou || y.amountCents - x.amountCents;
    });

    // Labelled with what the summed cents actually are, not with the
    // preference: balances() adds amountCents directly, never converting.
    return { currency: BASE_CURRENCY, balances };
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
