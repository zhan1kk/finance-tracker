import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  CreateSubcategoryInput,
  UpdateSubcategoryInput,
} from './types/subcategory.types';

@Injectable()
export class SubcategoryService {
  constructor(private readonly prisma: PrismaService) {}

  listSubcategories(userId: string) {
    return this.prisma.subcategory.findMany({ where: { userId } });
  }

  async getSubcategoryById(userId: string, id: string) {
    const subcategory = await this.prisma.subcategory.findFirst({
      where: { id, userId },
    });

    if (!subcategory) {
      throw new NotFoundException(`Subcategory with id ${id} was not found`);
    }

    return subcategory;
  }

  async createSubcategory(userId: string, input: CreateSubcategoryInput) {
    await this.ensureNameIsFree(userId, input.name);
    return this.prisma.subcategory.create({ data: { ...input, userId } });
  }

  async updateSubcategory(
    userId: string,
    id: string,
    input: UpdateSubcategoryInput,
  ) {
    const existing = await this.getSubcategoryById(userId, id);

    if (input.name && input.name !== existing.name) {
      await this.ensureNameIsFree(userId, input.name);
    }

    if (input.category && input.category !== existing.category) {
      // Account balances were adjusted based on the category at the time each
      // transaction was created; changing it would make them inconsistent.
      const transactionCount = await this.prisma.transaction.count({
        where: { subcategoryId: id },
      });
      if (transactionCount > 0) {
        throw new ConflictException(
          `Cannot change category: subcategory has ${transactionCount} transaction(s).`,
        );
      }
    }

    // `archived` is a boolean at the edge and a timestamp in the column: the
    // date a category was retired is worth keeping, and it costs nothing here.
    const { archived, ...rest } = input;
    return this.prisma.subcategory.update({
      where: { id },
      data: {
        ...rest,
        ...(archived === undefined
          ? {}
          : { archivedAt: archived ? new Date() : null }),
      },
    });
  }

  async deleteSubcategory(userId: string, id: string) {
    await this.getSubcategoryById(userId, id);

    const [transactionCount, recurringCount, pendingRowCount] =
      await Promise.all([
        this.prisma.transaction.count({ where: { subcategoryId: id } }),
        // Required relation, so the database refuses the delete outright. With
        // no exception filter in front of it that surfaced as a bare 500 rather
        // than something telling you which rule is in the way.
        this.prisma.recurringRule.count({ where: { subcategoryId: id } }),
        // ImportRow.subcategoryId is ON DELETE SET NULL, and a row with no
        // category fails the commit's `committable` filter — so deleting a
        // category chosen on a row still under review dropped that row's money
        // silently: no transaction, no error, batch still COMMITTED. The
        // account guard below learned this on 18 September; this is the same
        // check for the other half of the pair.
        //
        // predictedSubcategoryId is deliberately not counted. It is nulled the
        // same way, but losing a suggestion costs a line of display, not a row
        // — and guarding it would block deletes over rows nobody chose this
        // category for.
        this.prisma.importRow.count({
          where: {
            subcategoryId: id,
            batch: { userId, status: 'PENDING_REVIEW' },
          },
        }),
      ]);

    if (transactionCount > 0) {
      throw new ConflictException(
        `Cannot delete subcategory: it has ${transactionCount} transaction(s). Delete them first.`,
      );
    }
    if (recurringCount > 0) {
      throw new ConflictException(
        `Cannot delete subcategory: ${recurringCount} recurring transaction(s) post into it. Delete those rules first.`,
      );
    }
    if (pendingRowCount > 0) {
      throw new ConflictException(
        `Cannot delete subcategory: ${pendingRowCount} row(s) waiting in an import review are filed under it. Finish or discard that review first.`,
      );
    }

    // Take the rules that pointed here down with it. The FK is ON DELETE SET
    // NULL, so they would otherwise survive with an empty target — and a rule
    // that names a pattern but no target still matched rows on import, claimed
    // them from the categorizer, and let them commit with no category at all.
    // Rules are derived from corrections, not records in their own right, so
    // removing them with their target loses nothing a re-import cannot relearn.
    await this.prisma.$transaction([
      this.prisma.categorizationRule.deleteMany({
        where: { userId, subcategoryId: id },
      }),
      this.prisma.subcategory.delete({ where: { id } }),
    ]);
  }

  private async ensureNameIsFree(userId: string, name: string) {
    const duplicate = await this.prisma.subcategory.findUnique({
      where: { userId_name: { userId, name } },
    });
    if (!duplicate) return;
    // An archived category still holds its name — (userId, name) is unique in
    // the database, so the name cannot be handed to a second row and the check
    // cannot simply skip archived ones. What it can do is say so: archived
    // categories are hidden from the list, so "already exists" on a name with
    // nothing visible behind it is a dead end. Restoring is also the right
    // move, since it keeps the history already filed under that name.
    throw new ConflictException(
      duplicate.archivedAt
        ? `"${name}" already exists but is archived. Restore it from the archived list to use it again — its history is still attached.`
        : `Subcategory with a name ${name} already exists`,
    );
  }
}
