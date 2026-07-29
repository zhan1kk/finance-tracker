import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { BUDGETABLE_CATEGORIES } from '../../budgets/dtos/create-budget.dto';
import type { TransactionCategory } from '../../subcategories/types/subcategory.types';
import {
  findDuplicateHints,
  medianCents,
  scanBudgetWorkbook,
} from './budget-sheet';
import type { ImportBudgetItemDTO } from './dtos/spreadsheet.dto';
import { readWorkbook, XlsxError } from './xlsx-reader';

export type PreviewItem = {
  name: string;
  category: TransactionCategory;
  /** Median of the months that carried a budget; null when none did. */
  suggestedBudgetCents: number | null;
  samples: { sheet: string; cents: number }[];
  monthsSeen: number;
  /** Income cannot carry a spending budget. */
  budgetable: boolean;
  /** Already present, so applying would reuse rather than create it. */
  existingSubcategory: boolean;
  existingBudget: boolean;
  /** Set when the name exists under a different category than the sheet's. */
  existingCategory: TransactionCategory | null;
  /** A similar name in the same workbook, likely an older label for it. */
  similarTo: string | null;
};

@Injectable()
export class SpreadsheetImportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parses a budget workbook and proposes subcategories and monthly budgets,
   * cross-referenced against what the user already has. Nothing is written —
   * the user confirms the list, which then goes to `apply`.
   */
  async preview(userId: string, base64: string) {
    const buffer = decodeBase64(base64);
    let scan;
    try {
      scan = scanBudgetWorkbook(readWorkbook(buffer));
    } catch (error) {
      if (error instanceof XlsxError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException('Could not read the spreadsheet');
    }

    if (scan.entries.length === 0) {
      throw new BadRequestException(
        'No budget categories found. Expected sheets with a "SUB-CATEGORY" / "BUDGET" table under a category heading (EXPENSES, BILLS, …).',
      );
    }

    const existing = await this.prisma.subcategory.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        category: true,
        budgets: { select: { id: true } },
      },
    });
    const existingByName = new Map(
      existing.map((row) => [row.name.toLowerCase(), row]),
    );
    const hints = findDuplicateHints(scan.entries);

    const items: PreviewItem[] = scan.entries.map((entry) => {
      const match = existingByName.get(entry.name.toLowerCase());
      const budgetable = isBudgetable(entry.category);
      return {
        name: entry.name,
        category: entry.category,
        suggestedBudgetCents: budgetable
          ? medianCents(entry.samples.map((s) => s.cents))
          : null,
        samples: entry.samples,
        monthsSeen: entry.monthsSeen,
        budgetable,
        existingSubcategory: match !== undefined,
        existingBudget: (match?.budgets.length ?? 0) > 0,
        existingCategory:
          match && match.category !== entry.category ? match.category : null,
        similarTo: hints.get(entry.name) ?? null,
      };
    });

    // Most-established first: the ones worth keeping surface at the top.
    items.sort(
      (a, b) => b.monthsSeen - a.monthsSeen || a.name.localeCompare(b.name),
    );

    return { sheetsScanned: scan.sheetsScanned, items };
  }

  /**
   * Creates the confirmed subcategories and their budgets. Existing
   * subcategories are reused (never duplicated or re-categorized); a budget the
   * user confirmed overwrites an existing one for that subcategory.
   */
  async apply(userId: string, items: ImportBudgetItemDTO[]) {
    if (items.length === 0) {
      throw new BadRequestException('Nothing selected to import');
    }

    const result = {
      subcategoriesCreated: 0,
      subcategoriesReused: 0,
      budgetsCreated: 0,
      budgetsUpdated: 0,
      skipped: [] as { name: string; reason: string }[],
    };

    // One transaction so a failure part-way cannot leave a half-built setup.
    await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.subcategory.findMany({
          where: { userId },
          select: { id: true, name: true, category: true },
        });
        const byName = new Map(
          existing.map((row) => [row.name.toLowerCase(), row]),
        );
        const seen = new Set<string>();

        for (const item of items) {
          const name = item.name.trim().replace(/\s+/g, ' ');
          const key = name.toLowerCase();
          if (name === '' || seen.has(key)) continue;
          seen.add(key);

          let subcategory = byName.get(key);
          if (subcategory) {
            result.subcategoriesReused += 1;
          } else {
            subcategory = await tx.subcategory.create({
              data: { userId, name, category: item.category },
              select: { id: true, name: true, category: true },
            });
            byName.set(key, subcategory);
            result.subcategoriesCreated += 1;
          }

          const budgetCents = item.budgetCents ?? null;
          if (budgetCents === null) continue;
          // The subcategory's stored category governs, not the request: an
          // existing Income subcategory must not gain a spending budget.
          if (!isBudgetable(subcategory.category)) {
            result.skipped.push({
              name,
              reason: `${subcategory.category} cannot have a spending budget`,
            });
            continue;
          }

          const current = await tx.budget.findFirst({
            where: { userId, subcategoryId: subcategory.id },
            select: { id: true },
          });
          if (current) {
            await tx.budget.update({
              where: { id: current.id },
              data: { monthlyLimit: budgetCents },
            });
            result.budgetsUpdated += 1;
          } else {
            await tx.budget.create({
              data: { userId, subcategoryId: subcategory.id, monthlyLimit: budgetCents },
            });
            result.budgetsCreated += 1;
          }
        }
      },
      { timeout: 30_000 },
    );

    return result;
  }
}

function isBudgetable(category: TransactionCategory): boolean {
  return (BUDGETABLE_CATEGORIES as readonly string[]).includes(category);
}

function decodeBase64(value: string): Buffer {
  // Tolerate a data: URL prefix from the browser's FileReader.
  const payload = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestException('Spreadsheet file is empty or not valid base64');
  }
  return buffer;
}
