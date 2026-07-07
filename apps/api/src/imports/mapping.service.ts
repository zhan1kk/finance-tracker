import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ColumnMappingDTO } from './dtos/column-mapping.dto';

@Injectable()
export class MappingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string, accountId: string) {
    await this.assertOwnAccount(userId, accountId);
    return this.prisma.accountImportMapping.findUnique({
      where: { accountId },
    });
  }

  async upsert(userId: string, accountId: string, dto: ColumnMappingDTO) {
    await this.assertOwnAccount(userId, accountId);
    const data = {
      dateColumn: dto.dateColumn,
      amountColumn: dto.amountColumn,
      descriptionColumn: dto.descriptionColumn,
      dateFormat: dto.dateFormat ?? 'ISO',
      decimalSeparator: dto.decimalSeparator ?? '.',
      negativeIsExpense: dto.negativeIsExpense ?? true,
      hasHeader: dto.hasHeader ?? true,
    };
    return this.prisma.accountImportMapping.upsert({
      where: { accountId },
      create: { userId, accountId, ...data },
      update: data,
    });
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
}
