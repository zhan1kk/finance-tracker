import { AnthropicPdfExtractor } from './anthropic-extractor';

const ROW = { date: '2026-07-04', amount: -12.5, description: 'REWE' };

const withReply = (reply: unknown) => {
  const extractor = new AnthropicPdfExtractor('k', 'claude-test');
  (
    extractor as unknown as { client: { messages: { create: jest.Mock } } }
  ).client = { messages: { create: jest.fn().mockResolvedValue(reply) } };
  return extractor;
};

describe('AnthropicPdfExtractor', () => {
  it('reads the transactions from the tool call', async () => {
    const extractor = withReply({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', input: { transactions: [ROW] } }],
    });
    expect(await extractor.extractChunk('text')).toEqual([
      expect.objectContaining({ description: 'REWE' }),
    ]);
  });

  // Keeping the rows that made it before the cut would hand the import a
  // statement that looks complete with some of it missing.
  it('fails a reply cut off at the token limit, rows and all', async () => {
    const extractor = withReply({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', input: { transactions: [ROW] } }],
    });
    await expect(extractor.extractChunk('text')).rejects.toThrow(/cut off/);
  });

  it('fails a reply with no transactions call in it', async () => {
    const extractor = withReply({
      stop_reason: 'refusal',
      content: [{ type: 'text', text: 'no' }],
    });
    await expect(extractor.extractChunk('text')).rejects.toThrow(
      /stop reason: refusal/,
    );
  });
});
