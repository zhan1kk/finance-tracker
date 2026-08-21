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

  it('maps a valid structured response back to the real row ids', async () => {
    // The prompt aliases row ids to chunk indexes ("1", "2", …), so the model
    // answers in aliases; the provider must translate back to the real ids.
    mockFetchResolve({
      ok: true,
      json: () =>
        Promise.resolve({
          message: {
            content: JSON.stringify({
              items: [{ rowId: '1', subcategoryId: 'a', confidence: 0.9 }],
            }),
          },
        }),
    });
    expect(await provider.categorize([input('r1')], subs)).toEqual([
      { rowId: 'r1', subcategoryId: 'a', confidence: 0.9 },
    ]);
    const body = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string,
    );
    expect(body.messages[1].content).toContain('rowId 1');
    expect(body.messages[1].content).not.toContain('r1');
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
