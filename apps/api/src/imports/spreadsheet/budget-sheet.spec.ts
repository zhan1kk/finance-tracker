import {
  findDuplicateHints,
  medianCents,
  scanBudgetWorkbook,
  type ScannedEntry,
} from './budget-sheet';
import type { Sheet, SheetCells } from './xlsx-reader';

/** Builds a sparse sheet from `{ 'B3': 'value' }` style fixtures. */
function sheet(name: string, cells: Record<string, string>): Sheet {
  const grid: SheetCells = new Map();
  for (const [ref, value] of Object.entries(cells)) {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
    let col = 0;
    for (const char of letters) col = col * 26 + (char.charCodeAt(0) - 64);
    const row = Number(digits);
    if (!grid.has(row)) grid.set(row, new Map());
    grid.get(row)?.set(col - 1, value);
  }
  return { name, cells: grid };
}

/** One block: category label two rows above a SUB-CATEGORY/BUDGET header. */
const may = sheet('May', {
  B1: 'EXPENSES',
  B3: 'SUB-CATEGORY',
  D3: 'BUDGET',
  F3: 'REAL',
  B4: 'Groceries',
  D4: '€',
  E4: '700',
  F4: '699.28',
  B5: 'Restaurants',
  D5: '€',
  E5: '500',
  F5: '588.36',
  B6: 'TOTAL',
  E6: '1200',
});

describe('scanBudgetWorkbook', () => {
  it('reads names and budgets, ignoring the REAL column and the TOTAL row', () => {
    const { entries, sheetsScanned } = scanBudgetWorkbook([may]);
    expect(sheetsScanned).toEqual(['May']);
    expect(entries).toEqual([
      {
        name: 'Groceries',
        category: 'Expenses',
        samples: [{ sheet: 'May', cents: 70_000 }],
        monthsSeen: 1,
      },
      {
        name: 'Restaurants',
        category: 'Expenses',
        samples: [{ sheet: 'May', cents: 50_000 }],
        monthsSeen: 1,
      },
    ]);
  });

  it('merges the same subcategory across months, case-insensitively', () => {
    const april = sheet('April', {
      B1: 'EXPENSES',
      B3: 'SUB-CATEGORY',
      D3: 'BUDGET',
      B4: 'groceries',
      D4: '650',
    });
    const { entries } = scanBudgetWorkbook([may, april]);
    const groceries = entries.find((e) => e.name === 'Groceries');
    expect(groceries?.monthsSeen).toBe(2);
    expect(groceries?.samples).toEqual([
      { sheet: 'May', cents: 70_000 },
      { sheet: 'April', cents: 65_000 },
    ]);
  });

  it('reads each side-by-side block with its own category', () => {
    const twoBlocks = sheet('June', {
      B1: 'EXPENSES',
      B3: 'SUB-CATEGORY',
      D3: 'BUDGET',
      B4: 'Groceries',
      D4: '700',
      H1: 'BILLS',
      H3: 'SUB-CATEGORY',
      J3: 'BUDGET',
      H4: 'Rent',
      J4: '1580',
    });
    const { entries } = scanBudgetWorkbook([twoBlocks]);
    expect(entries).toEqual([
      expect.objectContaining({ name: 'Groceries', category: 'Expenses' }),
      expect.objectContaining({ name: 'Rent', category: 'Bills' }),
    ]);
  });

  it('treats an income block (SOURCE/EXPECTED) as the Income category', () => {
    const income = sheet('May', {
      B1: 'INCOME',
      B3: 'SOURCE',
      D3: 'EXPECTED',
      B4: "Kamila's Salary",
      D4: '2000',
    });
    const { entries } = scanBudgetWorkbook([income]);
    expect(entries[0]).toMatchObject({
      name: "Kamila's Salary",
      category: 'Income',
    });
  });

  it('skips a blank template month and any block with no category label', () => {
    const blank = sheet('July', { B3: 'SUB-CATEGORY', D3: 'BUDGET' });
    const orphan = sheet('Odd', {
      B1: 'BUDGET SUMMARY',
      B3: 'SUB-CATEGORY',
      D3: 'BUDGET',
      B4: 'Groceries',
      D4: '700',
    });
    expect(scanBudgetWorkbook([blank, orphan])).toEqual({
      entries: [],
      sheetsScanned: [],
    });
  });

  it('keeps a subcategory that never had a budget', () => {
    const noBudget = sheet('May', {
      B1: 'BILLS',
      B3: 'SUB-CATEGORY',
      D3: 'BUDGET',
      B4: 'Extra fees',
    });
    expect(scanBudgetWorkbook([noBudget]).entries[0]).toMatchObject({
      name: 'Extra fees',
      samples: [],
      monthsSeen: 1,
    });
  });

  it('stops after a run of blank rows rather than swallowing the next block', () => {
    const gap = sheet('May', {
      B1: 'EXPENSES',
      B3: 'SUB-CATEGORY',
      D3: 'BUDGET',
      B4: 'Groceries',
      D4: '700',
      B9: 'Not part of the block',
    });
    const { entries } = scanBudgetWorkbook([gap]);
    expect(entries.map((e) => e.name)).toEqual(['Groceries']);
  });
});

describe('medianCents', () => {
  it('returns null with no samples', () => {
    expect(medianCents([])).toBeNull();
  });

  it('takes the middle value, resisting a one-off spike', () => {
    // Gifts: 100, 50, then a 750 month — the median stays representative.
    expect(medianCents([10_000, 5_000, 75_000])).toBe(10_000);
  });

  it('averages the two middle values for an even count', () => {
    expect(medianCents([10_000, 20_000])).toBe(15_000);
  });
});

describe('findDuplicateHints', () => {
  const entry = (name: string, monthsSeen: number): ScannedEntry => ({
    name,
    category: 'Expenses',
    samples: [],
    monthsSeen,
  });

  it('points a stale alias at the better-established name', () => {
    const hints = findDuplicateHints([
      entry('Clothes/products', 4),
      entry('Clothes', 1),
      entry('Uber multpile subscriptions', 3),
      entry('Uber', 1),
    ]);
    expect(hints.get('Clothes')).toBe('Clothes/products');
    expect(hints.get('Uber')).toBe('Uber multpile subscriptions');
  });

  it('keeps the more specific label when both were seen equally often', () => {
    const hints = findDuplicateHints([
      entry('Clothes', 2),
      entry('Clothes/products', 2),
    ]);
    expect(hints.get('Clothes')).toBe('Clothes/products');
    expect(hints.has('Clothes/products')).toBe(false);
  });

  it('ignores short names and unrelated ones', () => {
    const hints = findDuplicateHints([
      entry('Era', 1),
      entry('Dias', 1),
      entry('Groceries', 4),
      entry("Kamila's Salary", 2),
      entry("Kamila's paycheck", 1),
    ]);
    expect(hints.size).toBe(0);
  });
});
