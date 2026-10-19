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
