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

  listSubcategories() {
    return this.prisma.subcategory.findMany();
  }

  async getSubcategoryById(id: string) {
    const subcategory = await this.prisma.subcategory.findUnique({
      where: { id },
    });

    if (!subcategory) {
      throw new NotFoundException(`Subcategory with id ${id} was not found`);
    }

    return subcategory;
  }

  async createSubcategory(input: CreateSubcategoryInput) {
    const duplicate = await this.prisma.subcategory.findUnique({
      where: { name: input.name },
    });

    if (duplicate) {
      throw new ConflictException(
        `Subcategory with a name ${input.name} already exists`,
      );
    }
    return this.prisma.subcategory.create({ data: input });
  }

  async updateSubcategory(id: string, input: UpdateSubcategoryInput) {
    const existing = await this.getSubcategoryById(id);

    if (input.name && input.name !== existing.name) {
      const duplicate = await this.prisma.subcategory.findUnique({
        where: { name: input.name },
      });
      if (duplicate) {
        throw new ConflictException(
          `Subcategory with a name ${input.name} already exists`,
        );
      }
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

  async deleteSubcategory(id: string) {
    await this.getSubcategoryById(id);

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
}
