import {
  buildPdfExtractionPrompt,
  coerceExtractedTransactions,
  PDF_EXTRACTION_SYSTEM_PROMPT,
  splitStatementText,
} from './pdf-prompt';

describe('coerceExtractedTransactions', () => {
  it('keeps well-formed rows and coerces a numeric-string amount', () => {
    expect(
      coerceExtractedTransactions([
        { date: '2026-06-01', amount: -42.5, description: 'Albert Heijn' },
        { date: '2026-06-02', amount: '30', description: '  Salary  ' },
      ]),
    ).toEqual([
      { date: '2026-06-01', amount: -42.5, description: 'Albert Heijn' },
      { date: '2026-06-02', amount: 30, description: 'Salary' },
    ]);
  });

  it('drops rows missing a date or a usable amount', () => {
    expect(
      coerceExtractedTransactions([
        { date: '', amount: -10, description: 'no date' },
        { date: '2026-06-03', amount: 0, description: 'zero' },
        { date: '2026-06-04', amount: 'abc', description: 'nan' },
        { date: '2026-06-05', amount: -9.99, description: 'ok' },
      ]),
    ).toEqual([{ date: '2026-06-05', amount: -9.99, description: 'ok' }]);
  });

  it('defaults an empty description and tolerates non-array input', () => {
    expect(
      coerceExtractedTransactions([
        { date: '2026-06-06', amount: 5, description: '' },
      ]),
    ).toEqual([{ date: '2026-06-06', amount: 5, description: 'Transaction' }]);
    expect(coerceExtractedTransactions(null)).toEqual([]);
    expect(coerceExtractedTransactions({})).toEqual([]);
  });
});

describe('buildPdfExtractionPrompt', () => {
  it('names the account currency so a two-amount line can be resolved', () => {
    const prompt = buildPdfExtractionPrompt('some statement', 'KZT');
    expect(prompt).toContain('denominated in KZT');
    expect(prompt).toContain('must be in KZT');
    expect(prompt).toContain('some statement');
  });

  it('omits the currency header when the account currency is unknown', () => {
    expect(buildPdfExtractionPrompt('some statement')).not.toContain(
      'denominated in',
    );
  });
});

describe('PDF_EXTRACTION_SYSTEM_PROMPT', () => {
  it('tells the model to ignore a bracketed converted amount', () => {
    // Kaspi prints "9 000,00 ₸ (15,00 €)"; taking the 15 would record 15 tenge.
    expect(PDF_EXTRACTION_SYSTEM_PROMPT).toMatch(/bracket/i);
    expect(PDF_EXTRACTION_SYSTEM_PROMPT).toMatch(/ACCOUNT'S OWN CURRENCY/);
  });
});

describe('splitStatementText', () => {
  const txn = (day: number) =>
    `${String(day).padStart(2, '0')}.08.2026 Card payment SOME MERCHANT GMBH Berlin -42,17 EUR`;
  const dated = (chunk: string) =>
    chunk.split('\n').filter((l) => /\d{2}\.08\.2026/.test(l)).length;

  it('keeps the pre-table header out of the chunks and repeats it to callers', () => {
    const { header, chunks } = splitStatementText(
      [
        'Vivid Money GmbH',
        'Period 01.08.2026 - 31.08.2026',
        txn(1),
        txn(2),
      ].join('\n'),
    );
    // The period line is dated, so the header stops before it — but the bank
    // name still travels with every chunk.
    expect(header).toBe('Vivid Money GmbH');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Period 01.08.2026');
    expect(chunks[0]).toContain(txn(2));
  });

  it('caps each chunk at ten transactions, however short the lines are', () => {
    const lines = Array.from({ length: 60 }, (_, i) => txn((i % 28) + 1));
    const { chunks } = splitStatementText(['Bank', ...lines].join('\n'));

    // The bug this replaces: a character budget let a densely printed
    // statement put thirty-odd transactions in one request, which timed out.
    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) expect(dated(chunk)).toBeLessThanOrEqual(10);
    // Nothing is lost and nothing is offered twice: the chunks rejoin to the
    // original body exactly, so a duplicate row can only be a real one.
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  it('keeps an entry printed over several lines in one piece', () => {
    const entry = (day: number) => [
      txn(day),
      '   Reference 1234567890',
      '   Original amount 45,00 USD',
    ];
    const lines = Array.from({ length: 24 }, (_, i) => entry(i + 1)).flat();
    const { chunks } = splitStatementText(['Bank', ...lines].join('\n'));

    // Every chunk starts on a dated line, so no continuation line is ever
    // orphaned from the transaction it belongs to.
    for (const chunk of chunks) {
      expect(chunk.split('\n')[0]).toMatch(/\d{2}\.08\.2026/);
    }
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  it('splits early on size when entries are verbose, before hitting ten', () => {
    const fat = (day: number) => [txn(day), `   ${'detail '.repeat(60)}`];
    const lines = Array.from({ length: 12 }, (_, i) => fat(i + 1)).flat();
    const { chunks } = splitStatementText(['Bank', ...lines].join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(dated(chunk)).toBeLessThan(10);
  });

  it('treats a statement with no recognisable date as all body', () => {
    const { header, chunks } = splitStatementText('nothing dated here\nat all');
    expect(header).toBe('');
    expect(chunks).toEqual(['nothing dated here\nat all']);
  });

  it('caps the header so a dateless preamble cannot swallow the statement', () => {
    const preamble = Array.from({ length: 30 }, (_, i) => `notice line ${i}`);
    const { header, chunks } = splitStatementText(
      [...preamble, txn(1)].join('\n'),
    );
    expect(header.split('\n')).toHaveLength(12);
    expect(chunks.join('\n')).toContain(txn(1));
  });
});
