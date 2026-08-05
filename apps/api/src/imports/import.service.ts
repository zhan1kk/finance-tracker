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
  /** Marked an internal move: commits, moves the balance, excluded from stats. */
  excludeFromStats: boolean;
  note: string | null;
};

/**
 * The committed transaction's description: the bank's text plus the user's
 * review-time annotation ("Starbucks · K's birthday brunch") — the bank text
 * stays for traceability, the note carries what it was actually for.
 */
function mergedDescription(row: {
  description: string;
  userNote: string | null;
}): string {
  if (!row.userNote) return row.description;
  return row.description ? `${row.description} · ${row.userNote}` : row.userNote;
}

// Amount columns are Postgres `Int` (32-bit). A value past this can't be stored
// and would otherwise surface as a 500 on insert. In practice it means a wrong
// decimal separator (a dot-decimal file read as comma turns 250000.00 into
// 25,000,000,000), so such a row is skipped with a hint rather than crashing.
const PG_INT_MAX = 2_147_483_647;

// Statement states that mean no money actually moved — a reverted, declined, or
// failed authorization (e.g. Revolut's −€1 Bolt hold that was REVERTED). Skipped
// at staging so they don't import as real spending. Matched only against
// *unmapped* columns (a bank's "State"/"Status"), never the mapped description,
// to avoid mistaking a merchant named "Failed" for a status.
const SKIP_STATES = new Set([
  'REVERTED',
  'REVERSED',
  'DECLINED',
  'FAILED',
  'CANCELLED',
  'CANCELED',
]);

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
            excludeFromStats: row.excludeFromStats,
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

  /**
   * Assigns a row a subcategory or a transfer counter account, and/or saves the
   * user's annotation. A note-only call leaves categorization state untouched —
   * jotting down "what was this" must not force a category decision.
   */
  async reviewRow(
    userId: string,
    batchId: string,
    rowId: string,
    choice: {
      subcategoryId?: string | null;
      counterAccountId?: string | null;
      excludeFromStats?: boolean;
      userNote?: string;
    },
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

    // Trimmed; an empty string clears the note.
    const userNote =
      choice.userNote !== undefined ? choice.userNote.trim() || null : undefined;

    const asInternal = choice.excludeFromStats === true;
    const asTransfer = Boolean(choice.counterAccountId);
    const asSubcategory = Boolean(choice.subcategoryId);
    if (!asInternal && !asTransfer && !asSubcategory) {
      if (userNote === undefined) {
        throw new BadRequestException(
          'Choose a category, a transfer account, mark it internal, or add a note',
        );
      }
      return this.prisma.importRow.update({
        where: { id: rowId },
        data: { userNote },
        include: {
          subcategory: { select: { id: true, name: true, category: true } },
          counterAccount: { select: { id: true, name: true } },
        },
      });
    }
    if ([asInternal, asTransfer, asSubcategory].filter(Boolean).length > 1) {
      throw new BadRequestException(
        'Choose only one of a category, a transfer account, or internal',
      );
    }
    if (asTransfer) {
      await this.assertTransferTarget(
        userId,
        batch.accountId,
        batch.account.currency,
        choice.counterAccountId as string,
      );
    } else if (asSubcategory) {
      await this.assertOwnSubcategory(userId, choice.subcategoryId as string);
    }

    return this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        subcategoryId: asSubcategory ? (choice.subcategoryId as string) : null,
        counterAccountId: asTransfer
          ? (choice.counterAccountId as string)
          : null,
        excludeFromStats: asInternal,
        // `corrected` gates rule-learning on commit. A transfer or internal mark
        // picked on a row no rule had already routed there is worth learning,
        // too — so future statements auto-route it without another manual pick.
        corrected: asInternal
          ? !row.excludeFromStats
          : asTransfer
            ? row.counterAccountId !== (choice.counterAccountId as string)
            : row.predictedSubcategoryId !== choice.subcategoryId,
        // Accepting the suggestion as-is keeps the categorizer as the deciding
        // source — the human co-signed, the prediction stood. Anything else is
        // a manual decision.
        source:
          asSubcategory &&
          row.predictedSubcategoryId !== null &&
          choice.subcategoryId === row.predictedSubcategoryId
            ? row.source
            : 'MANUAL',
        status: 'READY',
        note: null,
        userNote,
      },
      include: {
        subcategory: { select: { id: true, name: true, category: true } },
        counterAccount: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Flips a row between income and expense. The sign is inferred from the
   * statement, but some formats invert it (a credit card writes purchases
   * unsigned and payments negative), so the extractor can get a row backwards.
   * Flipping resets its categorization — the old guess was for the other
   * direction — and re-hashes it for dedup.
   */
  async flipRowDirection(userId: string, batchId: string, rowId: string) {
    const batch = await this.getPendingBatch(userId, batchId);
    const row = batch.rows.find((r) => r.id === rowId);
    if (!row) {
      throw new NotFoundException(`Row with id ${rowId} was not found`);
    }
    if (row.status === 'DUPLICATE') {
      throw new ConflictException('A duplicate row cannot be flipped');
    }
    const type: TransactionType = row.type === 'EXPENSE' ? 'INCOME' : 'EXPENSE';
    return this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        type,
        dedupeHash: dedupeHash({
          accountId: batch.accountId,
          date: row.date,
          type,
          amount: row.amount,
          normalizedDescription: row.normalizedDescription,
        }),
        // The previous categorization was for the opposite direction.
        subcategoryId: null,
        counterAccountId: null,
        excludeFromStats: false,
        predictedSubcategoryId: null,
        predictionSource: null,
        confidence: null,
        source: 'NONE',
        corrected: false,
        status: 'NEEDS_REVIEW',
        note: null,
      },
      include: {
        subcategory: { select: { id: true, name: true, category: true } },
        counterAccount: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Manually drops a row from the import (or restores it). The case dedup can't
   * catch: a charge that already exists under a different posting date — e.g. an
   * Amazon order placed on the 26th that settles on the 30th and so lands in the
   * next statement's window. SKIPPED rows are excluded from the commit; restoring
   * returns the row to READY if it already carries a decision, else NEEDS_REVIEW.
   */
  async setRowSkipped(
    userId: string,
    batchId: string,
    rowId: string,
    skipped: boolean,
  ) {
    const batch = await this.getPendingBatch(userId, batchId);
    const row = batch.rows.find((r) => r.id === rowId);
    if (!row) {
      throw new NotFoundException(`Row with id ${rowId} was not found`);
    }
    // A duplicate is already auto-excluded; there is nothing to toggle.
    if (row.status === 'DUPLICATE') {
      throw new ConflictException(
        'This row is already flagged as a duplicate and will not be imported',
      );
    }

    const hasDecision =
      row.subcategoryId !== null ||
      row.counterAccountId !== null ||
      row.excludeFromStats;
    const status = skipped
      ? 'SKIPPED'
      : hasDecision
        ? 'READY'
        : 'NEEDS_REVIEW';

    return this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        status,
        note: skipped ? 'Skipped — won’t be imported' : null,
      },
      include: {
        subcategory: { select: { id: true, name: true, category: true } },
        counterAccount: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Force-includes a row flagged as a duplicate ("import anyway"). The user is
   * asserting it's a genuinely separate charge that only looks like one already
   * in the ledger, so its dedupe hash is salted to be unique — it won't be
   * re-skipped at commit, and it won't shadow a real future duplicate. Returns
   * it to NEEDS_REVIEW so a category is chosen before it commits.
   */
  async overrideDuplicate(userId: string, batchId: string, rowId: string) {
    const batch = await this.getPendingBatch(userId, batchId);
    const row = batch.rows.find((r) => r.id === rowId);
    if (!row) {
      throw new NotFoundException(`Row with id ${rowId} was not found`);
    }
    if (row.status !== 'DUPLICATE') {
      throw new ConflictException(
        'Only a row flagged as a duplicate can be force-included',
      );
    }
    return this.prisma.importRow.update({
      where: { id: rowId },
      data: {
        status: 'NEEDS_REVIEW',
        dedupeHash: `${row.dedupeHash}:incl:${row.id.slice(0, 8)}`,
        note: 'Kept as a real charge — pick a category to include it',
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
        `Cannot transfer to ${account.name}: it is in ${account.currency}, not ` +
          `${currency}. A cross-currency move isn't one transfer — categorize ` +
          `this row as an expense/income and link it to the matching leg on the ` +
          `other account with "reimburses".`,
      );
    }
  }

  async commit(userId: string, batchId: string) {
    const batch = await this.getPendingBatch(userId, batchId);
    const committable = batch.rows.filter(
      (r) =>
        r.status === 'READY' &&
        (r.subcategoryId !== null ||
          r.counterAccountId !== null ||
          r.excludeFromStats),
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
        // Transfers this commit has already posted — so the mirror check only
        // matches a leg that was *already in the ledger*, never a second copy
        // from the same statement (two identical transfers seconds apart).
        const postedTransferIds: string[] = [];

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
            const posted = await this.commitTransferRow(
              tx,
              batch,
              row,
              convert,
              postedTransferIds,
            );
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
                description: mergedDescription(row),
                accountId: batch.accountId,
                subcategoryId: row.subcategoryId,
                excludeFromStats: row.excludeFromStats,
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
                : row.excludeFromStats
                  ? { excludeFromStats: true as const }
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
      userNote: string | null;
      dedupeHash: string;
      counterAccountId: string | null;
    },
    convert: (date: Date, amount: number) => number,
    postedTransferIds: string[],
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
        // Only a leg that predates this commit counts — never a second identical
        // transfer this same statement is posting.
        id: { notIn: postedTransferIds },
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
        description: mergedDescription(row),
        accountId: from,
        counterAccountId: to,
        dedupeHash: row.dedupeHash,
      },
    });
    postedTransferIds.push(transaction.id);
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

  /**
   * Reverses an accidental undo. Undo already restored every committed row to
   * READY (transaction links cleared) but left the batch in UNDONE, which no
   * longer opens for review or commit — a dead end. Flipping it back to
   * PENDING_REVIEW reopens it exactly as it stood pre-commit; the rows are
   * untouched, so review verdicts and categories survive the round trip.
   */
  async reopen(userId: string, batchId: string) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: batchId, userId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(
        `Import batch with id ${batchId} was not found`,
      );
    }
    if (batch.status !== 'UNDONE') {
      throw new ConflictException('Only an undone batch can be reopened');
    }
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { status: 'PENDING_REVIEW' },
    });
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
      const tooLarge =
        signedAmount !== null && Math.abs(signedAmount) > PG_INT_MAX;
      if (!date || signedAmount === null || signedAmount === 0 || tooLarge) {
        skipped.push({
          rowIndex,
          reason: !date
            ? 'unparseable date'
            : signedAmount === null
              ? 'unparseable amount'
              : signedAmount === 0
                ? 'zero amount'
                : 'amount out of range — check the decimal separator',
          raw,
        });
        return;
      }

      // Drop rows whose (unmapped) state column marks them as never booked.
      const stateHit = Object.entries(raw).find(
        ([col, val]) =>
          col !== mapping.dateColumn &&
          col !== mapping.amountColumn &&
          col !== mapping.descriptionColumn &&
          SKIP_STATES.has(String(val).trim().toUpperCase()),
      );
      if (stateHit) {
        skipped.push({
          rowIndex,
          reason: `not booked (status: ${String(stateHit[1]).trim()})`,
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
        excludeFromStats: false,
        note: null,
      });
    });

    return { staged, skipped };
  }

  /**
   * Flags rows that match a transaction *already in the ledger* as DUPLICATE —
   * the re-import case, excluded so a re-uploaded statement can't double-count.
   * The user can still force-include one via "import anyway" (see
   * {@link overrideDuplicate}). Rows that merely repeat *within this same file*
   * are left alone: a statement listing an identical charge twice (two €300
   * top-ups seconds apart, a bought-together pair of tickets) almost always
   * means it really happened twice, so both stay includable.
   */
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
    for (const row of staged) {
      if (committed.has(row.dedupeHash)) {
        row.status = 'DUPLICATE';
        row.note = 'Already imported in a previous statement';
      }
    }
  }

  private async categorize(
    userId: string,
    staged: StagedRow[],
    threshold: number,
  ) {
    // Only duplicates (rows already in the ledger) skip categorization; an
    // in-file repeat is a real charge and gets auto-categorized like any other.
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
        excludeFromStats: true,
      },
    });
    const forProvider: StagedRow[] = [];
    for (const row of pending) {
      const hit = this.rules.match(rules, row.normalizedDescription, row.type);
      if (!hit) {
        forProvider.push(row);
        continue;
      }
      if (hit.excludeFromStats) {
        // A learned internal move (own-account transfer / exchange): excluded
        // from stats, no subcategory or counter account.
        row.excludeFromStats = true;
        row.subcategoryId = null;
        row.counterAccountId = null;
      } else if (hit.counterAccountId) {
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
