import { HeuristicCategorizationProvider } from './heuristic.provider';
import type {
  CategorizationInput,
  SubcategoryLite,
} from '../types/import.types';

const SUBS: SubcategoryLite[] = [
  { id: 'groceries', name: 'Groceries', category: 'Expenses' },
  { id: 'rent', name: 'Rent', category: 'Bills' },
  { id: 'salary', name: 'Salary', category: 'Income' },
];

const input = (over: Partial<CategorizationInput>): CategorizationInput => ({
  rowId: 'r',
  description: '',
  normalizedDescription: '',
  amount: 1000,
  type: 'EXPENSE',
  ...over,
});

describe('HeuristicCategorizationProvider (name-match only)', () => {
  const provider = new HeuristicCategorizationProvider();

  it('predicts when a subcategory name appears as a word', async () => {
    const [pred] = await provider.categorize(
      [input({ normalizedDescription: 'monthly rent' })],
      SUBS,
    );
    expect(pred).toMatchObject({ subcategoryId: 'rent', confidence: 0.9 });
  });

  it('respects transaction type when choosing candidates', async () => {
    const [asIncome] = await provider.categorize(
      [input({ normalizedDescription: 'salary acme corp', type: 'INCOME' })],
      SUBS,
    );
    expect(asIncome.subcategoryId).toBe('salary');

    // The same text as an EXPENSE must not match the income-only subcategory.
    const [asExpense] = await provider.categorize(
      [input({ normalizedDescription: 'salary acme corp', type: 'EXPENSE' })],
      SUBS,
    );
    expect(asExpense.subcategoryId).toBeNull();
  });

  it('returns null for an unrecognized merchant (no brand dictionary)', async () => {
    const [pred] = await provider.categorize(
      [input({ normalizedDescription: 'albert heijn amsterdam' })],
      SUBS,
    );
    expect(pred).toMatchObject({ subcategoryId: null, confidence: 0 });
  });
});
