import {
  buildPdfExtractionPrompt,
  coerceExtractedTransactions,
  PDF_EXTRACTION_SYSTEM_PROMPT,
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
