import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CategorizationSource,
  type ImportRowStatus,
  Prisma,
  type TransactionType,
} from '@prisma/client';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import { CategorizationService } from './categorization/categorization.service';
import { CsvParserService } from './csv-parser.service';
import type { ColumnMappingDTO } from './dtos/column-mapping.dto';
import type { CreateImportDTO } from './dtos/create-import.dto';
import { MappingService } from './mapping.service';
import { dedupeHash, normalizeMerchant } from './normalization';
import { parseAmount, parseDate } from './parsing';
import { RulesService } from './rules.service';

type ResolvedMapping = Required<ColumnMappingDTO>;

type StagedRow = {
  rowIndex: number;
  raw: Record<string, string>;
  date: Date;
  amount: number;
  type: TransactionType;
  description: string;
  normalizedDescription: string;
  dedupeHash: string;
  status: ImportRowStatus;
  predictedSubcategoryId: string | null;
  confidence: number | null;
  source: CategorizationSource;
  /** Who made the prediction — frozen; `source` is overwritten on review. */
  predictionSource: CategorizationSource | null;
  subcategoryId: string | null;
  /** Set instead of subcategoryId when the row is a transfer between own accounts. */
  counterAccountId: string | null;
  note: string | null;
};

const BATCH_INCLUDE = {
  rows: {
    orderBy: { rowIndex: 'asc' },
    include: {
      subcategory: { select: { id: true, name: true, category: true } },
      predictedSubcategory: { select: { id: true, name: true } },
      counterAccount: { select: { id: true, name: true } },
    },
  },
  account: { select: { id: true, name: true, currency: true } },
} satisfies Prisma.ImportBatchInclude;

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly csv: CsvParserService,
    private readonly mapping: MappingService,
    private readonly rules: RulesService,
    private readonly categorization: CategorizationService,
    private readonly fx: FxService,
  ) {}

  /** Returns detected headers + a few sample rows so a UI can build a mapping. */
  inspect(csv: string, hasHeader = true) {
    const parsed = this.csv.parse(csv, hasHeader);
    return { headers: parsed.headers, sample: parsed.records.slice(0, 5) };
  }

  async createImport(userId: string, dto: CreateImportDTO) {
    await this.assertOwnAccount(userId, dto.accountId);
    const mapping = await this.resolveMapping(userId, dto);

    const parsed = this.csv.parse(dto.csv, mapping.hasHeader);
    for (const col of [
      mapping.dateColumn,
      mapping.amountColumn,
      mapping.descriptionColumn,
    ]) {
      if (!parsed.headers.includes(col)) {
        throw new BadRequestException(
          `Column "${col}" not found. Available columns: ${parsed.headers.join(', ')}`,
        );
      }
    }

    const { staged, skipped } = this.stageRows(
      parsed.records,
      mapping,
      dto.accountId,
    );
    await this.dedupe(dto.accountId, staged);

    const threshold =
      dto.threshold ??
      Number(this.config.get('DEFAULT_CATEGORIZATION_THRESHOLD') ?? 0.7);
    await this.categorize(userId, staged, threshold);

    const batch = await this.prisma.importBatch.create({
      data: {
        userId,
        accountId: dto.accountId,
        filename: dto.filename,
        threshold,
        provider: this.categorization.providerName,
        rows: {
          create: staged.map((row) => ({
            rowIndex: row.rowIndex,
            raw: row.raw,
            date: row.date,
            amount: row.amount,
            type: row.type,
            description: row.description,
            normalizedDescription: row.normalizedDescription,
            dedupeHash: row.dedupeHash,
            status: row.status,
            predictedSubcategoryId: row.predictedSubcategoryId,
            confidence: row.confidence,
            source: row.source,
            predictionSource: row.predictionSource,
            subcategoryId: row.subcategoryId,
            counterAccountId: row.counterAccountId,
            note: row.note,
          })),
        },
      },
      include: BATCH_INCLUDE,
    });

    return { batch, skipped };
  }

  async listBatches(userId: string) {
    const batches = await this.prisma.importBatch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { account: { select: { name: true } } },
    });
    const grouped = await this.prisma.importRow.groupBy({
      by: ['batchId', 'status'],
      where: { batch: { userId } },
      _count: true,
    });
    return batches.map((batch) => ({
      ...batch,
      counts: Object.fromEntries(
        grouped
          .filter((g) => g.batchId === batch.id)
          .map((g) => [g.status, g._count]),
      ) as Record<ImportRowStatus, number>,
    }));
  }

  async getBatch(userId: string, id: string) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id, userId },
      include: BATCH_INCLUDE,
    });
    if (!batch) {
      throw new NotFoundException(`Import batch with id ${id} was not found`);
    }
    return batch;
  }

  /** Assigns a row either a subcategory or a transfer counter account. */
  async reviewRow(
    userId: string,
    batchId: string,
    rowId: string,
    choice: { subcategoryId?: string | null; counterAccountId?: string | null },
  ) {
    const batch = await this.getPendingBatch(userId, batchId);
    const row = batch.rows.find((r) => r.id === rowId);
    if (!row) {
      throw new NotFoundException(`Row with id ${rowId} was not found`);
    }
    // A duplicate must not be reviewable into inclusion — that would let a
    // re-imported statement double-count. Excluding duplicates is the point.
    if (row.status === 'DUPLICATE') {
      throw new ConflictException(
        'This row duplicates an existing transaction and cannot be imported',
      );
    }

    const asTransfer = Boolean(choice.counterAccountId);
    if (asTransfer === Boolean(choice.subcategoryId)) {
      throw new BadRequestException(
        'Choose exactly one of a category or a transfer account',
      );
    }
    if (asTransfer) {
      await this.assertTransferTarget(
        userId,
        batch.accountId,
        batch.account.currency,
        choice.counterAccountId as string,
      );
    } else {
      await this.assertOwnSubcategory(userId, choice.subcategoryId as string);
    }

    return this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        subcategoryId: asTransfer ? null : (choice.subcategoryId as string),
        counterAccountId: asTransfer
          ? (choice.counterAccountId as string)
          : null,
        // `corrected` gates rule-learning on commit. A transfer picked on a row
        // no rule had already routed there is worth learning, too — so future
        // statements auto-route it without another manual pick.
        corrected: asTransfer
          ? row.counterAccountId !== (choice.counterAccountId as string)
          : row.predictedSubcategoryId !== choice.subcategoryId,
        // Accepting the suggestion as-is keeps the categorizer as the deciding
        // source — the human co-signed, the prediction stood. Anything else is
        // a manual decision.
        source:
          !asTransfer &&
          row.predictedSubcategoryId !== null &&
          choice.subcategoryId === row.predictedSubcategoryId
            ? row.source
            : 'MANUAL',
        status: 'READY',
        note: null,
      },
      include: {
        subcategory: { select: { id: true, name: true, category: true } },
        counterAccount: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * A transfer target must be another of the user's accounts in the same
   * currency — the ledger has no cross-currency transfer.
   */
  private async assertTransferTarget(
    userId: string,
    accountId: string,
    currency: string,
    counterAccountId: string,
  ) {
    if (counterAccountId === accountId) {
      throw new BadRequestException(
        'A transfer needs a different account on the other side',
      );
    }
    const account = await this.prisma.account.findFirst({
      where: { id: counterAccountId, userId },
      select: { currency: true, name: true },
    });
    if (!account) {
      throw new NotFoundException(
        `Account with id ${counterAccountId} was not found`,
      );
    }
    if (account.currency !== currency) {
      throw new BadRequestException(
        `Cannot transfer to ${account.name}: it is in ${account.currency}, not ${currency}`,
      );
    }
  }

  async commit(userId: string, batchId: string) {
    const batch = await this.getPendingBatch(userId, batchId);
    const committable = batch.rows.filter(
      (r) =>
        r.status === 'READY' &&
        (r.subcategoryId !== null || r.counterAccountId !== null),
    );
    const convert = await this.fx.converterFor(userId, batch.account.currency);

    await this.prisma.$transaction(
      async (tx) => {
        // Staging marks duplicates against transactions that existed *then*.
        // Rows staged before an earlier batch of the same statement was
        // committed carry no mark (e.g. the same file imported twice while both
        // sat in review) — so re-check at commit, or the second batch would
        // double-count. Hash lookup is global on purpose: a committed incoming
        // transfer lives on the counter account, not the batch's.
        const alreadyCommitted = new Set(
          (
            await tx.transaction.findMany({
              where: { dedupeHash: { in: committable.map((r) => r.dedupeHash) } },
              select: { dedupeHash: true },
            })
          ).map((t) => t.dedupeHash),
        );

        // Transfers move money between two accounts, so balance changes are
        // accumulated per account rather than only against the statement's.
        const deltas = new Map<string, number>();
        const bump = (accountId: string, amount: number) =>
          deltas.set(accountId, (deltas.get(accountId) ?? 0) + amount);

        for (const row of committable) {
          if (alreadyCommitted.has(row.dedupeHash)) {
            await tx.importRow.update({
              where: { id: row.id },
              data: {
                status: 'SKIPPED',
                note: 'Already imported by an earlier batch',
              },
            });
            continue;
          }
          if (row.counterAccountId) {
            const posted = await this.commitTransferRow(tx, batch, row, convert);
            if (posted) {
              bump(posted.from, -row.amount);
              bump(posted.to, row.amount);
            }
          } else {
            const transaction = await tx.transaction.create({
              data: {
                type: row.type,
                date: row.date,
                amount: row.amount,
                amountBase: convert(row.date, row.amount),
                description: row.description,
                accountId: batch.accountId,
                subcategoryId: row.subcategoryId,
                dedupeHash: row.dedupeHash,
              },
            });
            await tx.importRow.update({
              where: { id: row.id },
              data: { transactionId: transaction.id, status: 'COMMITTED' },
            });
            bump(batch.accountId, row.type === 'INCOME' ? row.amount : -row.amount);
          }

          if (row.corrected) {
            const target = row.counterAccountId
              ? { counterAccountId: row.counterAccountId }
              : row.subcategoryId
                ? { subcategoryId: row.subcategoryId }
                : null;
            if (target) {
              await this.rules.learnFromCorrection(
                tx,
                userId,
                row.normalizedDescription,
                target,
                row.type,
              );
            }
          }
        }

        for (const [accountId, delta] of deltas) {
          if (delta === 0) continue;
          await tx.account.update({
            where: { id: accountId },
            data: { balance: { increment: delta } },
          });
        }
        await tx.importBatch.update({
          where: { id: batch.id },
          data: { status: 'COMMITTED', committedAt: new Date() },
        });
      },
      { timeout: 30_000 },
    );

    return this.getBatch(userId, batchId);
  }

  /**
   * Posts one transfer row. Direction follows the statement: money leaving the
   * imported account moves out of it, money arriving moves into it.
   *
   * Both sides of a transfer are usually tracked here, so the same movement also
   * appears in the other account's statement with the opposite sign. Committing
   * both would double it, and the per-account dedupe hash cannot see across
   * accounts — hence the explicit check for an equivalent transfer.
   *
   * Returns the two account ids whose balances moved, or null when skipped.
   */
  private async commitTransferRow(
    tx: Prisma.TransactionClient,
    batch: { accountId: string },
    row: {
      id: string;
      date: Date;
      amount: number;
      type: TransactionType;
      description: string;
      dedupeHash: string;
      counterAccountId: string | null;
    },
    convert: (date: Date, amount: number) => number,
  ): Promise<{ from: string; to: string } | null> {
    const counterAccountId = row.counterAccountId as string;
    const movingOut = row.type === 'EXPENSE';
    const from = movingOut ? batch.accountId : counterAccountId;
    const to = movingOut ? counterAccountId : batch.accountId;

    const mirrored = await tx.transaction.findFirst({
      where: {
        type: 'TRANSFER',
        amount: row.amount,
        date: row.date,
        OR: [
          { accountId: from, counterAccountId: to },
          { accountId: to, counterAccountId: from },
        ],
      },
      select: { id: true },
    });
    if (mirrored) {
      await tx.importRow.update({
        where: { id: row.id },
        data: {
          status: 'SKIPPED',
          note: 'This transfer is already recorded from the other account',
        },
      });
      return null;
    }

    const transaction = await tx.transaction.create({
      data: {
        type: 'TRANSFER',
        date: row.date,
        amount: row.amount,
        amountBase: convert(row.date, row.amount),
        description: row.description,
        accountId: from,
        counterAccountId: to,
        dedupeHash: row.dedupeHash,
      },
    });
    await tx.importRow.update({
      where: { id: row.id },
      data: { transactionId: transaction.id, status: 'COMMITTED' },
    });
    return { from, to };
  }

  async undo(userId: string, batchId: string) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: batchId, userId },
      include: { rows: { where: { transactionId: { not: null } } } },
    });
    if (!batch) {
      throw new NotFoundException(
        `Import batch with id ${batchId} was not found`,
      );
    }
    if (batch.status !== 'COMMITTED') {
      throw new ConflictException('Only a committed batch can be undone');
    }

    const transactionIds = batch.rows
      .map((r) => r.transactionId)
      .filter((id): id is string => id !== null);

    const transactions = await this.prisma.transaction.findMany({
      where: { id: { in: transactionIds } },
      include: { _count: { select: { reimbursements: true } } },
    });
    const linked = transactions.filter((t) => t._count.reimbursements > 0);
    if (linked.length > 0) {
      throw new ConflictException(
        `Cannot undo: ${linked.length} imported transaction(s) have reimbursements linked to them. Remove those first.`,
      );
    }

    // Reverse each transaction against the account(s) it actually moved — a
    // transfer touched two, so undoing only the statement's would leave drift.
    const deltas = new Map<string, number>();
    const bump = (accountId: string, amount: number) =>
      deltas.set(accountId, (deltas.get(accountId) ?? 0) + amount);
    for (const t of transactions) {
      if (t.type === 'TRANSFER') {
        bump(t.accountId, t.amount);
        if (t.counterAccountId) bump(t.counterAccountId, -t.amount);
      } else {
        bump(t.accountId, t.type === 'INCOME' ? -t.amount : t.amount);
      }
    }

    await this.prisma.$transaction([
      this.prisma.importRow.updateMany({
        where: { batchId, transactionId: { not: null } },
        data: { status: 'READY', transactionId: null },
      }),
      this.prisma.transaction.deleteMany({
        where: { id: { in: transactionIds } },
      }),
      ...[...deltas.entries()]
        .filter(([, delta]) => delta !== 0)
        .map(([accountId, delta]) =>
          this.prisma.account.update({
            where: { id: accountId },
            data: { balance: { increment: delta } },
          }),
        ),
      this.prisma.importBatch.update({
        where: { id: batchId },
        data: { status: 'UNDONE', committedAt: null },
      }),
    ]);

    return this.getBatch(userId, batchId);
  }

  async discard(userId: string, batchId: string) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: batchId, userId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(
        `Import batch with id ${batchId} was not found`,
      );
    }
    if (batch.status === 'COMMITTED') {
      throw new ConflictException(
        'A committed batch cannot be discarded — undo it first',
      );
    }
    await this.prisma.importBatch.delete({ where: { id: batchId } });
    return { deleted: true };
  }

  /**
   * Categorization accuracy for the thesis metric: of the rows the categorizer
   * predicted and the user then committed, how often the prediction was kept —
   * overall, by source, and per batch over time.
   */
  async accuracyStats(userId: string) {
    // Filter on predictionSource, not source: source is overwritten to MANUAL
    // when a human reviews a row, and excluding reviewed rows would drop every
    // corrected (= wrong) prediction from the denominator, inflating accuracy.
    const rows = await this.prisma.importRow.findMany({
      where: {
        batch: { userId, status: 'COMMITTED' },
        status: 'COMMITTED',
        predictedSubcategoryId: { not: null },
        predictionSource: { in: ['RULE', 'LLM'] },
      },
      select: {
        predictedSubcategoryId: true,
        subcategoryId: true,
        corrected: true,
        predictionSource: true,
        batch: { select: { id: true, filename: true, committedAt: true } },
      },
    });

    const tally = (subset: typeof rows) => {
      const predicted = subset.length;
      const correct = subset.filter(
        (r) => !r.corrected && r.predictedSubcategoryId === r.subcategoryId,
      ).length;
      return {
        predicted,
        correct,
        accuracy: predicted === 0 ? null : correct / predicted,
      };
    };

    const byBatch = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byBatch.get(row.batch.id) ?? [];
      list.push(row);
      byBatch.set(row.batch.id, list);
    }

    return {
      overall: tally(rows),
      bySource: {
        RULE: tally(rows.filter((r) => r.predictionSource === 'RULE')),
        LLM: tally(rows.filter((r) => r.predictionSource === 'LLM')),
      },
      byBatch: [...byBatch.values()]
        .map((list) => ({
          batchId: list[0].batch.id,
          filename: list[0].batch.filename,
          committedAt: list[0].batch.committedAt,
          ...tally(list),
        }))
        .sort(
          (a, b) =>
            (a.committedAt?.getTime() ?? 0) - (b.committedAt?.getTime() ?? 0),
        ),
    };
  }

  // ---- staging / dedupe / categorization ----

  private stageRows(
    records: Record<string, string>[],
    mapping: ResolvedMapping,
    accountId: string,
  ) {
    const staged: StagedRow[] = [];
    const skipped: { rowIndex: number; reason: string; raw: unknown }[] = [];

    records.forEach((raw, index) => {
      const rowIndex = index + 1;
      const date = parseDate(raw[mapping.dateColumn] ?? '', mapping.dateFormat);
      const signedAmount = parseAmount(
        raw[mapping.amountColumn] ?? '',
        mapping.decimalSeparator,
      );
      if (!date || signedAmount === null || signedAmount === 0) {
        skipped.push({
          rowIndex,
          reason: !date
            ? 'unparseable date'
            : signedAmount === null
              ? 'unparseable amount'
              : 'zero amount',
          raw,
        });
        return;
      }

      const isExpense = mapping.negativeIsExpense
        ? signedAmount < 0
        : signedAmount > 0;
      const type: TransactionType = isExpense ? 'EXPENSE' : 'INCOME';
      const amount = Math.abs(signedAmount);
      const description = raw[mapping.descriptionColumn] ?? '';
      const normalizedDescription = normalizeMerchant(description);

      staged.push({
        rowIndex,
        raw,
        date,
        amount,
        type,
        description,
        normalizedDescription,
        dedupeHash: dedupeHash({
          accountId,
          date,
          type,
          amount,
          normalizedDescription,
        }),
        status: 'NEEDS_REVIEW',
        predictedSubcategoryId: null,
        confidence: null,
        source: 'NONE',
        predictionSource: null,
        subcategoryId: null,
        counterAccountId: null,
        note: null,
      });
    });

    return { staged, skipped };
  }

  /** Marks rows whose hash repeats within the batch or already exists committed. */
  private async dedupe(accountId: string, staged: StagedRow[]) {
    const existing = await this.prisma.transaction.findMany({
      where: {
        accountId,
        dedupeHash: { in: staged.map((r) => r.dedupeHash) },
      },
      select: { dedupeHash: true },
    });
    const committed = new Set(
      existing.map((t) => t.dedupeHash).filter((h): h is string => h !== null),
    );
    const seenInBatch = new Set<string>();
    for (const row of staged) {
      if (committed.has(row.dedupeHash)) {
        row.status = 'DUPLICATE';
        row.note = 'Already imported in a previous statement';
      } else if (seenInBatch.has(row.dedupeHash)) {
        row.status = 'DUPLICATE';
        row.note = 'Repeated within this file';
      } else {
        seenInBatch.add(row.dedupeHash);
      }
    }
  }

  private async categorize(
    userId: string,
    staged: StagedRow[],
    threshold: number,
  ) {
    const pending = staged.filter((r) => r.status !== 'DUPLICATE');
    if (pending.length === 0) return;

    const subcategories = await this.prisma.subcategory.findMany({
      where: { userId },
      select: { id: true, name: true, category: true },
    });

    // 1. Rule pre-pass.
    const rules = await this.prisma.categorizationRule.findMany({
      where: { userId },
      select: {
        id: true,
        pattern: true,
        type: true,
        subcategoryId: true,
        counterAccountId: true,
      },
    });
    const forProvider: StagedRow[] = [];
    for (const row of pending) {
      const hit = this.rules.match(rules, row.normalizedDescription, row.type);
      if (!hit) {
        forProvider.push(row);
        continue;
      }
      if (hit.counterAccountId) {
        // Movements between own accounts are not spending; they never reach the
        // categorizer and carry no subcategory.
        row.counterAccountId = hit.counterAccountId;
        row.subcategoryId = null;
      } else {
        row.predictedSubcategoryId = hit.subcategoryId ?? null;
        row.subcategoryId = hit.subcategoryId ?? null;
      }
      row.confidence = 1;
      row.source = 'RULE';
      row.predictionSource = 'RULE';
      row.status = 'READY';
    }

    // 2. Provider (heuristic or LLM) for the remainder.
    const predictions = await this.categorization.categorize(
      forProvider.map((r) => ({
        rowId: r.dedupeHash,
        description: r.description,
        normalizedDescription: r.normalizedDescription,
        amount: r.amount,
        type: r.type,
      })),
      subcategories,
    );
    const byRow = new Map(predictions.map((p) => [p.rowId, p]));
    for (const row of forProvider) {
      const pred = byRow.get(row.dedupeHash);
      if (pred && pred.subcategoryId) {
        row.predictedSubcategoryId = pred.subcategoryId;
        row.subcategoryId = pred.subcategoryId;
        row.confidence = pred.confidence;
        row.source = 'LLM';
        row.predictionSource = 'LLM';
        row.status = pred.confidence >= threshold ? 'READY' : 'NEEDS_REVIEW';
      } else {
        row.confidence = pred?.confidence ?? 0;
        row.source = 'NONE';
        row.status = 'NEEDS_REVIEW';
      }
    }
  }

  private async resolveMapping(
    userId: string,
    dto: CreateImportDTO,
  ): Promise<ResolvedMapping> {
    if (dto.mapping) {
      const saved = await this.mapping.upsert(
        userId,
        dto.accountId,
        dto.mapping,
      );
      return saved as ResolvedMapping;
    }
    const saved = await this.mapping.get(userId, dto.accountId);
    if (!saved) {
      throw new BadRequestException(
        'No column mapping provided and none saved for this account',
      );
    }
    return saved as ResolvedMapping;
  }

  private async getPendingBatch(userId: string, batchId: string) {
    const batch = await this.getBatch(userId, batchId);
    if (batch.status !== 'PENDING_REVIEW') {
      throw new ConflictException(
        `Batch is ${batch.status.toLowerCase()}, not open for review`,
      );
    }
    return batch;
  }

  private async assertOwnAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException(`Account with id ${accountId} was not found`);
    }
  }

  private async assertOwnSubcategory(userId: string, subcategoryId: string) {
    const found = await this.prisma.subcategory.findFirst({
      where: { id: subcategoryId, userId },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(
        `Subcategory with id ${subcategoryId} was not found`,
      );
    }
  }
}
