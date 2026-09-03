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
  const entries = (chunk: string) =>
    chunk.match(/\d{2}\.08\.2026/g)?.length ?? 0;

  it('keeps the pre-table header out of the chunks and repeats it to callers', () => {
    const { header, chunks } = splitStatementText(
      [
        'Vivid Money GmbH',
        'Period 01.08.2026 - 31.08.2026',
        txn(1),
        txn(2),
      ].join('\n'),
    );
    // The cut lands on the first date, which is inside the period line, so
    // "Period" stays behind with the bank name and the dates open the body.
    // Either way the period reaches every chunk, which is the point of it.
    expect(header).toBe('Vivid Money GmbH\nPeriod');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('01.08.2026 - 31.08.2026');
    expect(chunks[0]).toContain(txn(2));
  });

  it('splits a statement that arrives as one line, with no line breaks at all', () => {
    // What a real PDF table gives back: pdf.js sets hasEOL on almost nothing,
    // so unpdf returns the cells run together. A line-based split found no
    // boundary here and sent the lot as one chunk, which timed out.
    const run = Array.from({ length: 40 }, (_, i) => txn((i % 28) + 1)).join(
      ' ',
    );
    const { chunks } = splitStatementText(`Vivid Money GmbH ${run}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThanOrEqual(10);
    expect(chunks.join('')).toContain(txn(28));
  });

  it('finds a date with no word boundary before it', () => {
    // "…15,99 EUR01.08.2026 Metal plan…" — \b\d matches nothing here.
    const run = Array.from(
      { length: 30 },
      (_, i) => `${txn((i % 28) + 1)} EUR`,
    ).join('');
    const { chunks } = splitStatementText(run);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('caps each chunk at ten transactions, however short the entries are', () => {
    const lines = Array.from({ length: 60 }, (_, i) => txn((i % 28) + 1));
    const { chunks } = splitStatementText(['Bank', ...lines].join('\n'));

    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThanOrEqual(10);
    // Nothing is lost and nothing is offered twice: the chunks rejoin to the
    // original body exactly, so a duplicate row can only be a real one.
    expect(chunks.join('')).toBe(lines.join('\n'));
  });

  it('counts a booking/value date pair as one transaction, not two', () => {
    const paired = Array.from(
      { length: 20 },
      (_, i) =>
        `${String(i + 1).padStart(2, '0')}.08.2026 ${String(i + 1).padStart(2, '0')}.08.2026 MERCHANT -10,00 EUR`,
    ).join(' ');
    const { chunks } = splitStatementText(paired);
    // Forty date matches, but twenty entries: two chunks, not four.
    expect(chunks).toHaveLength(2);
  });

  it('keeps an entry printed over several lines in one piece', () => {
    const entry = (day: number) =>
      [
        txn(day),
        '   Reference 1234567890',
        '   Original amount 45,00 USD',
      ].join('\n');
    const body = Array.from({ length: 24 }, (_, i) => entry(i + 1)).join('\n');
    const { chunks } = splitStatementText(`Bank\n${body}`);

    // Every chunk opens on a date, so no continuation text is ever orphaned
    // from the transaction it belongs to.
    for (const chunk of chunks) expect(chunk).toMatch(/^\d{2}\.08\.2026/);
    expect(chunks.join('')).toBe(body);
  });

  it('splits early on size when entries are verbose, before hitting ten', () => {
    const body = Array.from(
      { length: 12 },
      (_, i) => `${txn(i + 1)} ${'detail '.repeat(60)}`,
    ).join('');
    const { chunks } = splitStatementText(`Bank\n${body}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThan(10);
  });

  it('bounds the chunks by size when nothing date-shaped is found', () => {
    // The safety net: an unrecognised date format must not put the whole
    // statement back into one request.
    const text = 'no dates here at all '.repeat(500);
    const { header, chunks } = splitStatementText(text);
    expect(header).toBe('');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('')).toBe(text);
  });

  it('caps the header so a long preamble cannot swallow the request', () => {
    const preamble = 'terms and conditions apply '.repeat(100);
    const { header, chunks } = splitStatementText(`${preamble}${txn(1)}`);
    expect(header.length).toBe(600);
    expect(chunks.join('')).toContain(txn(1));
  });
});
