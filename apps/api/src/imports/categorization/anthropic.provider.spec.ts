import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import type { SubcategoryLite } from '../types/import.types';
import {
  AnthropicCategorizationProvider,
  explainAnthropicError,
} from './anthropic.provider';

const apiError = (status: number, message: string) =>
  Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'x', message } },
    undefined,
    new Headers(),
  );

describe('explainAnthropicError', () => {
  it('names the causes that have a fix', () => {
    expect(explainAnthropicError(apiError(401, 'invalid x-api-key'))).toBe(
      'the API key was rejected',
    );
    expect(
      explainAnthropicError(
        apiError(
          400,
          'Your credit balance is too low to access the Anthropic API.',
        ),
      ),
    ).toBe('the Anthropic account is out of credit');
    expect(explainAnthropicError(apiError(404, 'model: nope'))).toBe(
      'the model name was not recognised',
    );
    expect(explainAnthropicError(apiError(529, 'Overloaded'))).toBe(
      'Claude is having problems right now, try again later',
    );
    expect(
      explainAnthropicError(new Anthropic.APIConnectionError({ message: '' })),
    ).toBe('this server could not reach Claude');
  });

  it("falls back to the API's own message, not the raw status and body", () => {
    expect(explainAnthropicError(apiError(400, 'max_tokens: too big'))).toBe(
      'max_tokens: too big',
    );
  });
});

describe('AnthropicCategorizationProvider', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  const subcategories: SubcategoryLite[] = [
    { id: 'sub-groceries', name: 'Groceries', category: 'Expenses' },
  ];
  const inputs = [
    {
      rowId: 'row-a',
      description: 'REWE',
      normalizedDescription: 'rewe',
      amount: 1250,
      type: 'EXPENSE' as const,
    },
  ];

  const withReply = (create: jest.Mock) => {
    const provider = new AnthropicCategorizationProvider('k', 'claude-test');
    (
      provider as unknown as { client: { messages: { create: jest.Mock } } }
    ).client = { messages: { create } };
    return provider;
  };

  it('marks every row of a failed call with the reason', async () => {
    const provider = withReply(
      jest.fn().mockRejectedValue(apiError(401, 'invalid x-api-key')),
    );
    expect(await provider.categorize(inputs, subcategories)).toEqual([
      {
        rowId: 'row-a',
        subcategoryId: null,
        confidence: 0,
        error: 'the API key was rejected',
      },
    ]);
  });

  // The README's privacy promise for this provider: "Sends each row's
  // description, amount and direction to Anthropic — nothing else."
  describe('what leaves the server', () => {
    // A row id is the import's dedupe hash (account, date, amount, merchant);
    // a subcategory id is a database key. Claude needs neither.
    const rowHash = 'c0ffee'.repeat(10) + 'beef';
    const subId = '7d2f0c1e-4b9a-4e3d-9c55-0a1b2c3d4e5f';
    const sentFor = async (
      rows: {
        description: string;
        amount: number;
        type: 'INCOME' | 'EXPENSE';
      }[],
    ): Promise<string> => {
      const create = jest.fn().mockResolvedValue({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', input: { items: [] } }],
      });
      await withReply(create).categorize(
        rows.map((r, i) => ({
          ...r,
          rowId: `${rowHash}${i}`,
          normalizedDescription: r.description.toLowerCase(),
        })),
        [{ id: subId, name: 'Groceries', category: 'Expenses' }],
      );
      return JSON.stringify(
        create.mock.calls.map((call) => call[0] as unknown),
      );
    };

    it("sends each row's description, amount and direction", async () => {
      const sent = await sentFor([
        { description: 'REWE Markt Berlin', amount: 1250, type: 'EXPENSE' },
        { description: 'ACME Payroll', amount: 250000, type: 'INCOME' },
      ]);
      expect(sent).toContain('REWE Markt Berlin');
      expect(sent).toContain('12.50');
      expect(sent).toContain('EXPENSE');
      expect(sent).toContain('ACME Payroll');
      expect(sent).toContain('2500.00');
      expect(sent).toContain('INCOME');
    });

    it('never sends the row ids or the subcategory ids', async () => {
      const sent = await sentFor([
        { description: 'REWE', amount: 1250, type: 'EXPENSE' },
      ]);
      expect(sent).not.toContain(rowHash);
      expect(sent).not.toContain(subId);
    });

    it('sends every row of a large import exactly once', async () => {
      const rows = Array.from({ length: 95 }, (_, i) => ({
        description: `merchant-${String(i).padStart(3, '0')}`,
        amount: 100 + i,
        type: 'EXPENSE' as const,
      }));
      const sent = await sentFor(rows);
      for (const r of rows) {
        expect(sent.split(r.description).length - 1).toBe(1);
      }
    });
  });

  it('leaves no error on an answer, even an unsure one', async () => {
    const provider = withReply(
      jest.fn().mockResolvedValue({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            input: { items: [{ rowId: '1', subcategoryId: null }] },
          },
        ],
      }),
    );
    const [prediction] = await provider.categorize(inputs, subcategories);
    expect(prediction.subcategoryId).toBeNull();
    expect(prediction.error).toBeUndefined();
  });
});
