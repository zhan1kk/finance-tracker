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

    return this.prisma.subcategory.update({ where: { id }, data: input });
  }

  async deleteSubcategory(userId: string, id: string) {
    await this.getSubcategoryById(userId, id);

    const transactionCount = await this.prisma.transaction.count({
      where: { subcategoryId: id },
    });

    if (transactionCount > 0) {
      throw new ConflictException(
        `Cannot delete subcategory: it has ${transactionCount} transaction(s). Delete them first.`,
      );
    }

    await this.prisma.subcategory.delete({ where: { id } });
  }

  private async ensureNameIsFree(userId: string, name: string) {
    const duplicate = await this.prisma.subcategory.findUnique({
      where: { userId_name: { userId, name } },
    });
    if (duplicate) {
      throw new ConflictException(
        `Subcategory with a name ${name} already exists`,
      );
    }
  }
}
