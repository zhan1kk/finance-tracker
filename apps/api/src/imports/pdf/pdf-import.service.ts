import { OLLAMA_KEEP_ALIVE } from '../../common/ollama';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../../common/env';
import type { CategorizerId } from '../categorization/categorizer.factory';
import { PrismaService } from '../../prisma.service';
import { ImportService } from '../import.service';
import {
  ANTHROPIC_CHUNK_CHARS,
  ANTHROPIC_CHUNK_TRANSACTIONS,
  AnthropicPdfExtractor,
} from './anthropic-extractor';
import {
  buildPdfExtractionPrompt,
  coerceExtractedTransactions,
  type ExtractedTransaction,
  PDF_EXTRACTION_SCHEMA,
  PDF_EXTRACTION_SYSTEM_PROMPT,
  splitStatementText,
} from './pdf-prompt';

// Per chunk, not per statement: a cold local model loads slowly, and a chunk
// of a dozen transactions is still a few hundred tokens to write out.
const REQUEST_TIMEOUT_MS = 180_000;
// Ollama's default context is small (a few thousand tokens); a monthly
// statement plus the prompt needs more room, or rows past the cut-off vanish.
const NUM_CTX = 8192;

/**
 * Turns an uploaded PDF statement into a normal import batch: extract the text
 * (Mozilla's pdf.js via unpdf), have a local Ollama model read it a chunk at a
 * time into {date, amount, description} rows, then feed those through the exact
 * same pipeline as a CSV — dedup, rules, categorization, and the review screen —
 * so nothing is committed without the user confirming it.
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
      categorizerModel?: string;
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
    return this.imports.createImport(
      userId,
      {
        accountId: input.accountId,
        filename: input.filename,
        csv: this.toCsv(rows),
        // Reading the PDF is always local; this only picks who categorizes the
        // rows it produced.
        categorizer: input.categorizer,
        categorizerModel: input.categorizerModel,
        extractMs,
        // Describes the CSV this service just generated, not any statement
        // the user has — so it is used to parse and then forgotten, rather
        // than saved as the account's remembered layout.
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
          descriptionColumn: 'Description',
          dateFormat: 'ISO',
          decimalSeparator: '.',
          negativeIsExpense: true,
          hasHeader: true,
        },
      },
      { rememberMapping: false },
    );
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

  /**
   * Reads the statement a chunk at a time and concatenates the results.
   *
   * One request for the whole statement is what made a normal month fail: the
   * reply has to spell out every transaction, so the generation grows with the
   * statement while the timeout stays fixed, and a cut-off reply is not valid
   * JSON — three minutes of work thrown away with nothing to review. Asking for
   * a dozen transactions at a time keeps every request the same size no matter
   * how long the statement is.
   *
   * Sequential, like the Ollama categorizer: a local Ollama runs one generation
   * at a time, so parallel chunks would only queue up and race the timeout.
   */
  private async extractTransactions(
    text: string,
    currency?: string,
  ): Promise<ExtractedTransaction[]> {
    const claude = this.anthropicExtractor();
    const baseUrl =
      optionalSetting(this.config, 'OLLAMA_BASE_URL') ??
      'http://localhost:11434';
    // A leaner model can be set for extraction jobs via OLLAMA_EXTRACTION_MODEL
    // (see the reminder extractor); falls back to OLLAMA_MODEL.
    const model =
      claude?.model ??
      optionalSetting(this.config, 'OLLAMA_EXTRACTION_MODEL') ??
      optionalSetting(this.config, 'OLLAMA_MODEL') ??
      'llama3.1';

    const { header, chunks } = splitStatementText(
      text,
      claude
        ? {
            maxTransactions: ANTHROPIC_CHUNK_TRANSACTIONS,
            maxChars: ANTHROPIC_CHUNK_CHARS,
          }
        : {},
    );
    // Logged before the first call, because when this stage fails it fails
    // slowly: knowing the shape of the text up front is the difference between
    // reading one line of log and guessing at what the PDF looked like. Which
    // reader ran is named for the same reason the categorizer names its
    // provider at boot — a statement's text leaving the machine is not
    // something to infer afterwards from a model name.
    this.logger.log(
      `PDF extraction: ${text.length} chars, ${text.split('\n').length} lines, ${chunks.length} chunk(s), ${
        claude
          ? `Claude (${model}) — statement text leaves this machine`
          : `local Ollama (${model}) — nothing leaves this machine`
      }`,
    );
    const rows: ExtractedTransaction[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const part = header ? `${header}\n\n${chunk}` : chunk;
      try {
        rows.push(
          ...(claude
            ? await claude.extractChunk(part, currency)
            : await this.extractChunk(part, baseUrl, model, currency)),
        );
      } catch (err) {
        // Naming the part that failed matters: "it timed out" on its own gives
        // no clue whether the model is unreachable or merely too slow for this
        // machine, which are opposite fixes.
        const detail = claude
          ? `Claude could not read the PDF (part ${i + 1} of ${chunks.length}, model "${model}"): ${
              err instanceof Error ? err.message : String(err)
            }`
          : err instanceof Error && err.name === 'AbortError'
            ? `Ollama took too long to read the PDF (timed out on part ${i + 1} of ${chunks.length}, model "${model}"). A smaller OLLAMA_EXTRACTION_MODEL would read it faster.`
            : err instanceof BadRequestException
              ? err.message
              : `Ollama extraction failed: ${
                  err instanceof Error ? err.message : String(err)
                }. Is Ollama running at ${baseUrl}?`;
        this.logger.error(detail);
        // Everything or nothing. Returning the parts that did come back would
        // look like a complete statement and quietly lose the rest.
        throw new BadRequestException(detail);
      }
      this.logger.log(
        `PDF extraction: part ${i + 1}/${chunks.length}, ${rows.length} transactions so far`,
      );
    }
    return rows;
  }

  /**
   * The hosted reader, or null to read locally.
   *
   * PDF_EXTRACTOR names it outright; with nothing set it follows the presence
   * of an API key, the same inference CategorizerFactory makes. Deliberately
   * its own setting rather than reusing CATEGORIZER: extraction sends the whole
   * statement while categorization sends a description and an amount, so
   * "read it locally, categorize with Claude" is a combination worth allowing.
   */
  private anthropicExtractor(): AnthropicPdfExtractor | null {
    const key = optionalSetting(this.config, 'ANTHROPIC_API_KEY');
    const configured = (
      optionalSetting(this.config, 'PDF_EXTRACTOR') ?? ''
    ).toLowerCase();

    if (configured === 'ollama') return null;
    if (configured === 'anthropic' && !key) {
      throw new BadRequestException(
        'PDF_EXTRACTOR is "anthropic" but this server has no ANTHROPIC_API_KEY',
      );
    }
    if (configured && configured !== 'anthropic') {
      this.logger.warn(
        `Unrecognized PDF_EXTRACTOR="${configured}" — reading PDFs locally`,
      );
      return null;
    }
    if (!key) return null;

    return new AnthropicPdfExtractor(
      key,
      optionalSetting(this.config, 'ANTHROPIC_EXTRACTION_MODEL') ??
        optionalSetting(this.config, 'ANTHROPIC_MODEL') ??
        'claude-sonnet-5',
    );
  }

  /** One /api/chat call for one slice of the statement. */
  private async extractChunk(
    text: string,
    baseUrl: string,
    model: string,
    currency?: string,
  ): Promise<ExtractedTransaction[]> {
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
