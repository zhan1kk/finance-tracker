import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma.service';
import type { ImportService } from '../import.service';
import { PdfImportService } from './pdf-import.service';
import type { ExtractedTransaction } from './pdf-prompt';

/**
 * A PDF import generates its own CSV, so the mapping it hands the CSV pipeline
 * describes that generated file — not any statement layout the user has. It
 * was being saved as the account's remembered format all the same, and four
 * real accounts (Gold Kaspi, Advanzia, Vivid, K Klarna) were found carrying
 * the generated Date/Amount/Description/ISO layout instead of their own. Their
 * next real CSV import would have been parsed with the wrong columns.
 *
 * The flag that prevents it is one argument at one call site, which is exactly
 * the kind of thing that gets dropped in a refactor without anything noticing.
 */
describe('PdfImportService column mapping', () => {
  const buildService = (settings: Record<string, string> = {}) => {
    const createImport = jest.fn().mockResolvedValue({ batch: { id: 'b1' } });
    const service = new PdfImportService(
      {
        get: jest.fn((key: string) => settings[key]),
      } as unknown as ConfigService,
      { createImport } as unknown as ImportService,
      {
        account: {
          findFirst: jest.fn().mockResolvedValue({ currency: 'EUR' }),
        },
      } as unknown as PrismaService,
    );

    // Assigned rather than spied: this test is about what reaches the CSV
    // pipeline, and neither reading a PDF nor running a model is part of that.
    const internals = service as unknown as {
      extractText: (pdfBase64: string) => Promise<string>;
      extractTransactions: (
        text: string,
        currency?: string,
      ) => Promise<ExtractedTransaction[]>;
    };
    internals.extractText = () => Promise.resolve('statement text');
    internals.extractTransactions = () =>
      Promise.resolve([
        { date: '2026-09-01', amount: -12.5, description: 'Some Shop' },
      ]);

    return { service, createImport };
  };

  it('parses with its generated mapping without saving it to the account', async () => {
    const { service, createImport } = buildService();

    await service.importPdf('user-1', {
      accountId: 'account-1',
      filename: 'statement.pdf',
      pdfBase64: 'irrelevant',
    });

    expect(createImport).toHaveBeenCalledTimes(1);
    const [userId, dto, options] = createImport.mock.calls[0] as [
      string,
      { mapping: { dateColumn: string } },
      { rememberMapping?: boolean },
    ];

    expect(userId).toBe('user-1');
    // The mapping is still passed — the generated CSV cannot be parsed without
    // it. It simply must not be remembered.
    expect(dto.mapping.dateColumn).toBe('Date');
    expect(options).toEqual({ rememberMapping: false });
  });
});

/**
 * Who reads a statement decides whether its full text leaves the machine, so
 * the default has to be the quiet-and-local one. An ANTHROPIC_API_KEY is set in
 * production for categorization; if that alone flipped the reader, a deploy
 * touching nothing else would have started sending whole bank statements to a
 * hosted model. That exact failure — a provider inferred rather than chosen —
 * already sent a month of imports somewhere nobody intended.
 */
describe('PdfImportService reader selection', () => {
  const readerFor = (settings: Record<string, string>): string => {
    const service = new PdfImportService(
      {
        get: jest.fn((key: string) => settings[key]),
      } as unknown as ConfigService,
      {} as unknown as ImportService,
      {} as unknown as PrismaService,
    );
    const pick = (
      service as unknown as { anthropicExtractor: () => unknown }
    ).anthropicExtractor.bind(service);
    return pick() === null ? 'ollama' : 'anthropic';
  };

  it('reads locally when nothing is configured, even with an API key set', () => {
    expect(readerFor({})).toBe('ollama');
    expect(readerFor({ ANTHROPIC_API_KEY: 'sk-test' })).toBe('ollama');
    expect(
      readerFor({ ANTHROPIC_API_KEY: 'sk-test', CATEGORIZER: 'anthropic' }),
    ).toBe('ollama');
  });

  it('uses Claude only when asked for by name', () => {
    expect(
      readerFor({ PDF_EXTRACTOR: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' }),
    ).toBe('anthropic');
    expect(
      readerFor({ PDF_EXTRACTOR: 'ollama', ANTHROPIC_API_KEY: 'sk-test' }),
    ).toBe('ollama');
  });

  it('refuses rather than falling back when Claude is asked for with no key', () => {
    expect(() => readerFor({ PDF_EXTRACTOR: 'anthropic' })).toThrow(
      /no ANTHROPIC_API_KEY/,
    );
  });

  it('falls back to local on a value it does not recognise', () => {
    expect(
      readerFor({ PDF_EXTRACTOR: 'claude', ANTHROPIC_API_KEY: 'sk-test' }),
    ).toBe('ollama');
  });
});
