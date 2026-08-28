import { Logger } from '@nestjs/common';
import type {
  CategorizationInput,
  SubcategoryLite,
} from '../types/import.types';
import { OllamaCategorizationProvider } from './ollama.provider';

const input = (rowId: string): CategorizationInput => ({
  rowId,
  description: 'REWE',
  normalizedDescription: 'rewe',
  amount: 2254,
  type: 'EXPENSE',
});
const subs: SubcategoryLite[] = [
  { id: 'a', name: 'Groceries', category: 'Expenses' },
];

const mockFetchResolve = (value: unknown) =>
  jest.spyOn(global, 'fetch').mockResolvedValue(value as Response);

describe('OllamaCategorizationProvider', () => {
  const provider = new OllamaCategorizationProvider(
    'http://localhost:11434',
    'llama3.1',
  );

  beforeEach(() => {
    // Failures are logged; keep the expected-error tests quiet.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** Categorization is two calls: parent category, then subcategory. */
  const mockTwoStage = (
    parentAlias: string | null,
    subAlias: string | null,
  ) => {
    const reply = (id: string | null, confidence: number) => ({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: JSON.stringify({
              items: [{ rowId: '1', subcategoryId: id, confidence }],
            }),
          },
        }),
    });
    return jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(reply(parentAlias, 0.9) as unknown as Response)
      .mockResolvedValueOnce(reply(subAlias, 0.9) as unknown as Response);
  };

  it("asks for a parent category first, then only that parent's subcategories", async () => {
    mockTwoStage('p1', 'c1');
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: 'a', confidence: 0.9 },
    ]);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    // Stage one offers broad categories, not the subcategory list.
    const first = JSON.parse(calls[0][1].body as string);
    expect(first.messages[1].content).toContain('Expenses');
    expect(first.messages[1].content).not.toContain('Groceries');
    // Stage two offers the subcategories, with row ids still aliased.
    const second = JSON.parse(calls[1][1].body as string);
    expect(second.messages[1].content).toContain('Groceries');
    expect(second.messages[1].content).toContain('rowId 1');
    expect(second.messages[1].content).not.toContain('r1');
  });

  // Guessing against the full list is what produced confident nonsense, so a
  // row whose parent could not be determined is left for the user instead.
  it('returns null when the parent stage gives nothing usable', async () => {
    mockTwoStage(null, 'c1');
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: null, confidence: 0 },
    ]);
    // No second call: there was no parent to narrow to.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('never offers Income categories to an expense row', async () => {
    mockTwoStage('p1', 'c1');
    await provider.categorize(
      [input('r1')],
      [...subs, { id: 'b', name: 'Salary', category: 'Income' }],
    );
    const first = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string,
    );
    expect(first.messages[1].content).not.toContain('Income');
  });

  it('falls back to null predictions on a non-OK response', async () => {
    mockFetchResolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: null, confidence: 0 },
    ]);
  });

  it('falls back when the model returns content that is not JSON', async () => {
    mockFetchResolve({
      ok: true,
      json: () =>
        Promise.resolve({ message: { content: 'sorry, I cannot do that' } }),
    });
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: null, confidence: 0 },
    ]);
  });

  it('falls back when the request fails (Ollama not running)', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: null, confidence: 0 },
    ]);
  });
});
