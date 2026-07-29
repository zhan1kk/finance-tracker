import type { TransactionCategory } from '../../subcategories/types/subcategory.types';
import type { Sheet, SheetCells } from './xlsx-reader';

/**
 * Extracts subcategories and their monthly budgets from a budget workbook.
 *
 * The layout it understands (the common "monthly budget" spreadsheet shape):
 * each month is a sheet holding several blocks side by side, one per category.
 * A block is a `SUB-CATEGORY | BUDGET | REAL | …` header row with the category
 * name (EXPENSES, BILLS, …) a row or two above it in the same column, and the
 * rows underneath listing each subcategory until a TOTAL or blank run.
 *
 * Only names and budgets are read. Actual/spent figures are deliberately
 * ignored: they carry one-off events (debts, lump sums, foreign-currency trips)
 * that would misrepresent history if imported as transactions.
 */

/** Header text that starts a block, and the budget header that follows it. */
const NAME_HEADERS = new Set(['SUB-CATEGORY', 'SUBCATEGORY', 'SOURCE']);
const BUDGET_HEADERS = new Set(['BUDGET', 'EXPECTED']);

const CATEGORY_BY_LABEL = new Map<string, TransactionCategory>([
  ['INCOME', 'Income'],
  ['EXPENSES', 'Expenses'],
  ['EXPENSE', 'Expenses'],
  ['BILLS', 'Bills'],
  ['SUBSCRIPTIONS', 'Subscriptions'],
  ['DEBTS', 'Debts'],
  ['SAVINGS', 'Savings'],
]);

/** How far above a header row to look for the block's category label. */
const CATEGORY_LOOKUP_ROWS = 6;
/** Columns to the right of the name column to search for the budget column. */
const BUDGET_SEARCH_WIDTH = 20;
/** Columns after the budget header to search for its number (currency symbols
 *  often occupy the header column itself, pushing the value one cell right). */
const VALUE_SEARCH_WIDTH = 3;
/** Guards against runaway scans on odd sheets. */
const MAX_BLOCK_ROWS = 300;
const BLANK_RUN_LIMIT = 3;

export type ScannedEntry = {
  name: string;
  category: TransactionCategory;
  /** Each sheet that carried a positive budget, in workbook order. */
  samples: { sheet: string; cents: number }[];
  /** Number of sheets the subcategory appeared in at all. */
  monthsSeen: number;
};

export type ScanResult = {
  entries: ScannedEntry[];
  sheetsScanned: string[];
};

export function scanBudgetWorkbook(sheets: Sheet[]): ScanResult {
  const byKey = new Map<string, ScannedEntry>();
  const sheetsScanned: string[] = [];

  for (const sheet of sheets) {
    const found = scanSheet(sheet.cells);
    if (found.length === 0) continue;
    sheetsScanned.push(sheet.name);

    // Collapse duplicates inside one sheet so a name repeated in two blocks
    // still counts as a single appearance for that month.
    const seenThisSheet = new Set<string>();
    for (const item of found) {
      const key = item.name.toLowerCase();
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          name: item.name,
          category: item.category,
          samples: [],
          monthsSeen: 0,
        };
        byKey.set(key, entry);
      }
      if (!seenThisSheet.has(key)) {
        seenThisSheet.add(key);
        entry.monthsSeen += 1;
      }
      if (item.budgetCents !== null && item.budgetCents > 0) {
        entry.samples.push({ sheet: sheet.name, cents: item.budgetCents });
      }
    }
  }

  return { entries: [...byKey.values()], sheetsScanned };
}

/**
 * Flags names that look like older labels for the same thing — "Clothes" vs
 * "Clothes/products", "Uber" vs "Uber multpile subscriptions" — by testing
 * whether one normalized name contains the other. The entry seen in fewer
 * months is treated as the stale alias. Returns alias name -> canonical name.
 *
 * Deliberately conservative (containment only, minimum length): it is a review
 * hint, not an automatic merge. Genuine synonyms with no shared substring
 * ("Salary" vs "paycheck") are left for the user to spot.
 */
export function findDuplicateHints(entries: ScannedEntry[]): Map<string, string> {
  const MIN_LENGTH = 4;
  const keyed = entries.map((entry) => ({
    entry,
    key: entry.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  }));
  const hints = new Map<string, string>();

  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i];
      const b = keyed[j];
      if (a.key === b.key || a.key.length < MIN_LENGTH || b.key.length < MIN_LENGTH) {
        continue;
      }
      if (!a.key.includes(b.key) && !b.key.includes(a.key)) continue;

      // The name seen in more months wins; on a tie keep the more specific
      // (longer) label, which is usually the refined current one —
      // "Clothes/products" rather than the older bare "Clothes".
      const [alias, canonical] =
        a.entry.monthsSeen === b.entry.monthsSeen
          ? a.key.length <= b.key.length
            ? [a.entry, b.entry]
            : [b.entry, a.entry]
          : a.entry.monthsSeen < b.entry.monthsSeen
            ? [a.entry, b.entry]
            : [b.entry, a.entry];
      if (!hints.has(alias.name)) hints.set(alias.name, canonical.name);
    }
  }
  return hints;
}

/** The suggested budget: the median of the months that had one. */
export function medianCents(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value);
}

type SheetItem = {
  name: string;
  category: TransactionCategory;
  budgetCents: number | null;
};

function scanSheet(cells: SheetCells): SheetItem[] {
  const items: SheetItem[] = [];

  for (const [rowNumber, row] of cells) {
    const nameColumns = [...row.entries()]
      .filter(([, text]) => NAME_HEADERS.has(normalize(text)))
      .map(([column]) => column)
      .sort((a, b) => a - b);
    if (nameColumns.length === 0) continue;

    // Every header cell in this row starts a block; a block's columns end where
    // the next block begins.
    const headerColumns = [...row.keys()].sort((a, b) => a - b);
    for (const nameColumn of nameColumns) {
      const nextBlock = nameColumns.find((c) => c > nameColumn);
      const limit = Math.min(
        nextBlock ?? nameColumn + BUDGET_SEARCH_WIDTH,
        nameColumn + BUDGET_SEARCH_WIDTH,
      );
      const budgetColumn = headerColumns.find(
        (c) =>
          c > nameColumn && c < limit && BUDGET_HEADERS.has(normalize(row.get(c) ?? '')),
      );
      const category = findCategory(cells, rowNumber, nameColumn);
      if (!category) continue;
      items.push(...readBlock(cells, rowNumber, nameColumn, budgetColumn, category));
    }
  }

  return items;
}

/** Looks upward in the header's own column for the block's category label. */
function findCategory(
  cells: SheetCells,
  headerRow: number,
  column: number,
): TransactionCategory | null {
  for (let row = headerRow - 1; row >= headerRow - CATEGORY_LOOKUP_ROWS; row--) {
    const text = cells.get(row)?.get(column);
    if (!text) continue;
    const category = CATEGORY_BY_LABEL.get(normalize(text));
    if (category) return category;
  }
  return null;
}

function readBlock(
  cells: SheetCells,
  headerRow: number,
  nameColumn: number,
  budgetColumn: number | undefined,
  category: TransactionCategory,
): SheetItem[] {
  const items: SheetItem[] = [];
  let blanks = 0;

  for (let row = headerRow + 1; row <= headerRow + MAX_BLOCK_ROWS; row++) {
    const name = cells.get(row)?.get(nameColumn)?.trim();
    if (!name) {
      if (++blanks >= BLANK_RUN_LIMIT) break;
      continue;
    }
    blanks = 0;

    const upper = normalize(name);
    if (upper === 'TOTAL') break;
    // A number or a repeated header in the name column is layout, not a category.
    if (isNumeric(name) || NAME_HEADERS.has(upper) || CATEGORY_BY_LABEL.has(upper)) {
      continue;
    }

    items.push({
      name: name.replace(/\s+/g, ' '),
      category,
      budgetCents:
        budgetColumn === undefined
          ? null
          : firstNumberInCents(cells, row, budgetColumn),
    });
  }

  return items;
}

/** The budget figure, allowing for a currency-symbol cell before the number. */
function firstNumberInCents(
  cells: SheetCells,
  row: number,
  from: number,
): number | null {
  for (let column = from; column <= from + VALUE_SEARCH_WIDTH; column++) {
    const text = cells.get(row)?.get(column);
    if (text && isNumeric(text)) {
      return Math.round(Number(text) * 100);
    }
  }
  return null;
}

function normalize(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

function isNumeric(text: string): boolean {
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.trim());
}
