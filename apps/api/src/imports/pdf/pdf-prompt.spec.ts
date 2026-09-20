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

  // The local reader's five-per-chunk default exists to keep a CPU model inside
  // its timeout. Claude has no such limit and re-pays for the header on every
  // chunk, so it asks for bigger ones; if this parameter stopped being honoured
  // a hosted import would silently go back to paying for 8 headers instead of 1.
  it('honours a caller-supplied chunk size', () => {
    const text = Array.from({ length: 20 }, (_, i) => txn(i + 1)).join('\n');

    const local = splitStatementText(text);
    expect(local.chunks.length).toBe(4);
    expect(Math.max(...local.chunks.map(entries))).toBe(5);

    const hosted = splitStatementText(text, {
      maxTransactions: 40,
      maxChars: 24_000,
    });
    expect(hosted.chunks.length).toBe(1);
    expect(entries(hosted.chunks[0])).toBe(20);
  });

  it('keeps the pre-table header out of the chunks and repeats it to callers', () => {
    const { header, chunks } = splitStatementText(
      [
        'Vivid Money GmbH',
        'Period 01.08.2026 - 31.08.2026',
        txn(1),
        txn(2),
        txn(3),
      ].join('\n'),
    );
    // The period line does not *open* with its date, so it stays whole in the
    // header and travels with every chunk — which is the point of the header.
    expect(header).toBe('Vivid Money GmbH\nPeriod 01.08.2026 - 31.08.2026');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(txn(3));
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
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThanOrEqual(5);
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

  it('caps each chunk at five transactions, however short the entries are', () => {
    const lines = Array.from({ length: 60 }, (_, i) => txn((i % 28) + 1));
    const { chunks } = splitStatementText(['Bank', ...lines].join('\n'));

    expect(chunks).toHaveLength(12);
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThanOrEqual(5);
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
    // Forty date matches, but twenty entries: four chunks, not eight.
    expect(chunks).toHaveLength(4);
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
      (_, i) => `${txn(i + 1)} ${'detail '.repeat(120)}`,
    ).join('');
    const { chunks } = splitStatementText(`Bank\n${body}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(entries(chunk)).toBeLessThan(5);
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

  it('caps a long preamble, cutting on a line boundary', () => {
    // The bug this replaces: a flat character cut landed mid-sentence on
    // "Balance statement for the period from | 28.07.26 to 25.08.26", so every
    // chunk but the first lost the period and one row was dated to the
    // letterhead instead.
    const preamble = `${'terms and conditions apply\n'.repeat(100)}`;
    const { header, chunks } = splitStatementText(`${preamble}${txn(1)}`);
    expect(header.length).toBeLessThanOrEqual(1500);
    expect(header.endsWith('apply')).toBe(true);
    expect(chunks.join('')).toContain(txn(1));
  });

  it('ignores dates buried in summary lines when rows open with theirs', () => {
    // A real Kaspi statement: a covering letter and a table of totals, all
    // carrying dates. Counting those as entries spent half a chunk's budget on
    // the summary, so the next chunk was overstuffed and dropped a row.
    const preamble = [
      'JSC «Kaspi Bank», BIC CASPKZKA',
      'Balance statement for the period from 28.07.26 to 25.08.26 is attached.',
      'Card balance 28.07.26 + 3 932,80 ₸',
      'Card balance 25.08.26 + 16 886,54 ₸',
      'Date Amount Transaction Details',
    ].join('\n');
    const rows = Array.from({ length: 12 }, (_, i) =>
      [
        `${String(i + 1).padStart(2, '0')}.08.26 - 10 000,00 ₸ Transfer to your`,
        'account',
      ].join('\n'),
    ).join('\n');
    const { header, chunks } = splitStatementText(`${preamble}\n${rows}`);

    // The whole preamble stays in the header, period included.
    expect(header).toBe(preamble);
    expect(chunks).toHaveLength(3);
    expect(
      chunks[0].split('\n').filter((l) => /^\d{2}\.08\.26/.test(l)),
    ).toHaveLength(5);
    // The wrapped "account" line stays with the transaction it belongs to.
    expect(chunks[0]).toContain('Transfer to your\naccount');
  });
});
