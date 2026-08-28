import { OLLAMA_KEEP_ALIVE } from '../../common/ollama';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../../common/env';
import type { CategorizerId } from '../categorization/categorizer.factory';
import { PrismaService } from '../../prisma.service';
import { ImportService } from '../import.service';
import {
  buildPdfExtractionPrompt,
  coerceExtractedTransactions,
  type ExtractedTransaction,
  PDF_EXTRACTION_SCHEMA,
  PDF_EXTRACTION_SYSTEM_PROMPT,
} from './pdf-prompt';

// Extraction of a whole statement is a bigger generation than categorising one
// chunk, and a cold local model loads slowly — allow plenty of time.
const REQUEST_TIMEOUT_MS = 180_000;
// Ollama's default context is small (a few thousand tokens); a monthly
// statement plus the prompt needs more room, or rows past the cut-off vanish.
const NUM_CTX = 8192;

/**
 * Turns an uploaded PDF statement into a normal import batch: extract the text
 * (Mozilla's pdf.js via unpdf), have a local Ollama model read it into
 * {date, amount, description} rows, then feed those through the exact same
 * pipeline as a CSV — dedup, rules, categorization, and the review screen — so
 * nothing is committed without the user confirming it.
 *
 * Always uses Ollama (OLLAMA_BASE_URL / OLLAMA_MODEL), independent of the
 * CATEGORIZER setting: extraction is a local, private, zero-cost step whatever
 * provider categorization happens to use.
 */
@Injectable()
export class PdfImportService {
  private readonly logger = new Logger(PdfImportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly imports: ImportService,
    private readonly prisma: PrismaService,
  ) {}

  async importPdf(
    userId: string,
    input: {
      accountId: string;
      filename: string;
      pdfBase64: string;
      categorizer?: CategorizerId;
    },
  ) {
    // Extraction is timed separately from categorization: a PDF pays for
    // reading the file *and* for the model, and only one of those changes when
    // the model does.
    const extractStart = Date.now();
    const text = await this.extractText(input.pdfBase64);
    if (text.trim().length === 0) {
      throw new BadRequestException(
        "Couldn't read any text from this PDF — it may be a scanned image, which isn't supported. Try a CSV export instead.",
      );
    }

    const account = await this.prisma.account.findFirst({
      where: { id: input.accountId, userId },
      select: { currency: true },
    });
    const rows = await this.extractTransactions(text, account?.currency);
    const extractMs = Date.now() - extractStart;
    if (rows.length === 0) {
      throw new BadRequestException(
        'No transactions could be extracted from the PDF. You can still import a CSV instead.',
      );
    }

    // Hand off to the CSV pipeline with a fixed mapping — the extractor already
    // emits ISO dates and signed, dot-decimal amounts.
    return this.imports.createImport(userId, {
      accountId: input.accountId,
      filename: input.filename,
      csv: this.toCsv(rows),
      // Reading the PDF is always local; this only picks who categorizes the
      // rows it produced.
      categorizer: input.categorizer,
      extractMs,
      mapping: {
        dateColumn: 'Date',
        amountColumn: 'Amount',
        descriptionColumn: 'Description',
        dateFormat: 'ISO',
        decimalSeparator: '.',
        negativeIsExpense: true,
        hasHeader: true,
      },
    });
  }

  private async extractText(pdfBase64: string): Promise<string> {
    const buffer = Buffer.from(pdfBase64, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('Empty PDF upload.');
    }
    try {
      // unpdf is ESM-only; a dynamic import keeps it out of the CommonJS graph.
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : (text ?? '');
    } catch (err) {
      this.logger.error(
        `PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Could not read this PDF file.');
    }
  }

  private async extractTransactions(
    text: string,
    currency?: string,
  ): Promise<ExtractedTransaction[]> {
    const baseUrl =
      optionalSetting(this.config, 'OLLAMA_BASE_URL') ??
      'http://localhost:11434';
    // A leaner model can be set for extraction jobs via OLLAMA_EXTRACTION_MODEL
    // (see the reminder extractor); falls back to OLLAMA_MODEL.
    const model =
      optionalSetting(this.config, 'OLLAMA_EXTRACTION_MODEL') ??
      optionalSetting(this.config, 'OLLAMA_MODEL') ??
      'llama3.1';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          // Hybrid models (qwen3) reason at length before answering unless
          // told not to; on CPU that reasoning is most of the wall time and is
          // what pushed these calls past their timeout. See ollama.provider.ts.
          think: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: PDF_EXTRACTION_SCHEMA,
          options: { temperature: 0, num_ctx: NUM_CTX },
          messages: [
            { role: 'system', content: PDF_EXTRACTION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildPdfExtractionPrompt(text, currency),
            },
          ],
        }),
      });

      if (!res.ok) {
        throw new BadRequestException(
          `Ollama extraction failed (HTTP ${res.status}). Is Ollama running and the model "${model}" pulled?`,
        );
      }

      // Non-streaming /api/chat returns { message: { content: "<json string>" } }.
      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data.message?.content;
      if (typeof content !== 'string') return [];
      const parsed = JSON.parse(content) as { transactions?: unknown };
      return coerceExtractedTransactions(parsed.transactions);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Ollama took too long to read the PDF (timed out).'
          : `Ollama extraction failed: ${
              err instanceof Error ? err.message : String(err)
            }. Is Ollama running at ${baseUrl}?`;
      this.logger.error(message);
      throw new BadRequestException(message);
    } finally {
      clearTimeout(timer);
    }
  }

  private toCsv(rows: ExtractedTransaction[]): string {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['Date,Amount,Description'];
    for (const r of rows) {
      lines.push([esc(r.date), esc(r.amount), esc(r.description)].join(','));
    }
    return lines.join('\n');
  }
}
