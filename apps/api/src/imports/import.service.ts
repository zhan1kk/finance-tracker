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
import type { CategorizationProvider } from './types/import.types';
import { CsvParserService } from './csv-parser.service';
import type { ColumnMappingDTO } from './dtos/column-mapping.dto';
import type { CreateImportDTO } from './dtos/create-import.dto';
import { MappingService } from './mapping.service';
import { numericSetting } from '../common/env';
import { dedupeHash, normalizeMerchant } from './normalization';
import { openIousReadFrom } from '../reminders/source-cleanup';
import { parseAmount, parseDate } from './parsing';
import { RulesService } from './rules.service';

// feeColumn is genuinely absent for most banks, so it stays nullable rather
// than being forced to a string by Required<>.
type ResolvedMapping = Required<Omit<ColumnMappingDTO, 'feeColumn'>> & {
  feeColumn: string | null;
};

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
  /** The rule that matched, when one did, so commit can count its usage. */
  ruleId?: string | null;
  subcategoryId: string | null;
  /** Set instead of subcategoryId when the row is a transfer between own accounts. */
  counterAccountId: string | null;
  /** Marked an internal move: commits, moves the balance, excluded from stats. */
  excludeFromStats: boolean;
  note: string | null;
  /**
   * A fee staged alongside the charge it was taken on. Lives only for the
   * length of the import — nothing downstream needs it, but the rule pre-pass
   * does. Not persisted.
   */
  isFee?: boolean;
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
  return row.description
    ? `${row.description} · ${row.userNote}`
    : row.userNote;
}

// Amount columns are Postgres `Int` (32-bit). A value past this can't be stored
// and would otherwise surface as a 500 on insert. In practice it means a wrong
// decimal separator (a dot-decimal file read as comma turns 250000.00 into
// 25,000,000,000), so such a row is skipped with a hint rather than crashing.
const PG_INT_MAX = 2_147_483_647;

// A transfer posts to its two accounts' statements on the same day when it's
// instant (Revolut) but a few days apart when it clears through an external
// bank. Exact-date mirror legs auto-merge at commit; within this many days we
// don't merge silently (that once killed genuine repeats) — we warn at review
// so the user can Skip the duplicate leg themselves.
const TRANSFER_WARN_DAYS = 5;

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

// For statement formats with no status column, a reversal shows up as two rows:
// the charge and an equal, opposite-signed entry from the same merchant a day
// or two later. We don't auto-remove them — a genuine refund you *want* to keep
// looks identical — so we just note both so the reviewer can Skip the pair if
// it truly cancels out.
const REVERSAL_WINDOW_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Notes rows that look like the two halves of a reversal (charge + refund). */
function flagReversalPairs(staged: StagedRow[]): void {
  const windowMs = REVERSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  for (let i = 0; i < staged.length; i++) {
    const a = staged[i];
    if (a.status === 'DUPLICATE' || a.note) continue;
    for (let j = i + 1; j < staged.length; j++) {
      const b = staged[j];
      if (b.status === 'DUPLICATE' || b.note) continue;
      if (
        a.type !== b.type &&
        a.amount === b.amount &&
        a.normalizedDescription === b.normalizedDescription &&
        Math.abs(a.date.getTime() - b.date.getTime()) <= windowMs
      ) {
        a.note = `Possible reversal: matches an opposite entry on ${day(b.date)} — Skip both if it's a refund that cancels out.`;
        b.note = `Possible reversal: matches an opposite entry on ${day(a.date)} — Skip both if it's a refund that cancels out.`;
        break;
      }
    }
  }
}

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

  /**
   * `options.rememberMapping` is false for callers whose mapping describes
   * nothing the user chose — the PDF importer hands in a fixed one because it
   * generates the CSV itself, and saving that as the account's format replaced
   * whatever real statement layout was there.
   */
  async createImport(
    userId: string,
    dto: CreateImportDTO,
    options: { rememberMapping?: boolean } = {},
  ) {
    await this.assertOwnAccount(userId, dto.accountId);
    const mapping = await this.resolveMapping(userId, dto, options);

    const parsed = this.csv.parse(dto.csv, mapping.hasHeader);
    for (const col of [
      mapping.dateColumn,
      mapping.amountColumn,
      mapping.descriptionColumn,
      ...(mapping.feeColumn ? [mapping.feeColumn] : []),
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
    flagReversalPairs(staged);
    await this.flagPossibleDuplicates(dto.accountId, staged);

    const threshold =
      dto.threshold ??
      numericSetting(this.config, 'DEFAULT_CATEGORIZATION_THRESHOLD', 0.7);
    // Resolved once and then carried, so the batch records the provider that
    // actually ran this import rather than whatever is configured by the time
    // the row is written.
    const provider = this.categorization.resolve(
      dto.categorizer,
      dto.categorizerModel,
    );
    // Timed on its own, excluding parsing and PDF extraction, so a model
    // comparison is not muddied by how long a file took to read.
    const categorizeStart = Date.now();
    await this.categorize(userId, dto.accountId, staged, threshold, provider);
    const categorizeMs = Date.now() - categorizeStart;

    const batch = await this.prisma.importBatch.create({
      data: {
        userId,
        accountId: dto.accountId,
        filename: dto.filename,
        threshold,
        provider: provider.name,
        model: provider.modelName ?? null,
        categorizeMs,
        extractMs: dto.extractMs ?? null,
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
            ruleId: row.ruleId ?? null,
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
      choice.userNote !== undefined
        ? choice.userNote.trim() || null
        : undefined;

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
    let transferWarning: string | null = null;
    if (asTransfer) {
      await this.assertTransferTarget(
        userId,
        batch.accountId,
        batch.account.currency,
        choice.counterAccountId as string,
      );
      transferWarning = await this.nearDateMirrorWarning(
        batch.accountId,
        choice.counterAccountId as string,
        row,
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
        note: transferWarning,
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
        // The rule that matched matched the *other* direction, so its id is no
        // longer true of this row. Left behind it did two kinds of damage:
        // undo decremented a hitCount this row never incremented (the count
        // could go negative), and the "am I overruling the rule that fired?"
        // check at commit saw a rule that had not fired, so categorizing a
        // flipped row silently taught nothing.
        ruleId: null,
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
    const status = skipped ? 'SKIPPED' : hasDecision ? 'READY' : 'NEEDS_REVIEW';

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
    // Rules that fired and were kept, so their usage can be counted, and rules
    // learned from this batch, so the review screen can show what it just
    // taught itself and offer to undo any of it.
    const usedRuleIds: string[] = [];
    const learnedRuleIds: string[] = [];
    // Patterns of the rules that categorized these rows, so a correction can
    // tell "you are overruling this exact rule" from "you are teaching a more
    // specific one".
    const matchedRulePattern = new Map<string, string>(
      (
        await this.prisma.categorizationRule.findMany({
          where: {
            userId,
            id: {
              in: batch.rows
                .map((r) => r.ruleId)
                .filter((id): id is string => id !== null),
            },
          },
          select: { id: true, pattern: true },
        })
      ).map((r) => [r.id, r.pattern]),
    );
    // A merchant corrected to two different categories inside one batch cannot
    // teach a single rule; the upsert would just let the last row win.
    const correctedTargets = new Map<string, Set<string>>();
    for (const r of batch.rows) {
      if (!r.corrected) continue;
      const key = r.normalizedDescription;
      const target =
        r.counterAccountId ??
        r.subcategoryId ??
        (r.excludeFromStats ? '~' : '');
      if (!correctedTargets.has(key)) correctedTargets.set(key, new Set());
      correctedTargets.get(key)?.add(target);
    }
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
              where: {
                dedupeHash: { in: committable.map((r) => r.dedupeHash) },
              },
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
            } else {
              // Mirrored by the other account's statement: the row was marked
              // SKIPPED and no transaction exists, so nothing below applies.
              continue;
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
            bump(
              batch.accountId,
              row.type === 'INCOME' ? row.amount : -row.amount,
            );
          }

          // A rule that fired and was left alone has been used. One that fired
          // and was corrected has not, so it is not counted.
          if (row.predictionSource === 'RULE' && !row.corrected && row.ruleId) {
            usedRuleIds.push(row.ruleId);
          }

          // A correction teaches a rule, with two exceptions.
          //
          // First: overruling the *same* rule that fired. Two IKEA charges on
          // one day, curtains and meatballs, are one merchant with two honest
          // answers, and upserting would repoint "ikea" for every future
          // import. Compared by pattern, not just by "a rule fired": correcting
          // AMAZON PRIME VIDEO where the rule "amazon" matched teaches the
          // longer "amazon prime video", which wins longest-match and leaves
          // the broad rule alone. That refinement is the useful case.
          const overrulesSameRule =
            row.ruleId !== null &&
            matchedRulePattern.get(row.ruleId) === row.normalizedDescription;
          // Second: the same merchant corrected to different categories inside
          // this batch. Nothing here can say which one is the rule, and the
          // upsert would silently keep whichever row came last.
          const conflicting =
            (correctedTargets.get(row.normalizedDescription)?.size ?? 0) > 1;

          if (row.corrected && !overrulesSameRule && !conflicting) {
            const target = row.counterAccountId
              ? { counterAccountId: row.counterAccountId }
              : row.subcategoryId
                ? { subcategoryId: row.subcategoryId }
                : row.excludeFromStats
                  ? { excludeFromStats: true as const }
                  : null;
            if (target) {
              const rule = await this.rules.learnFromCorrection(
                tx,
                userId,
                row.normalizedDescription,
                target,
                row.type,
              );
              if (rule) learnedRuleIds.push(rule.id);
            }
          }
        }

        await this.rules.countUsage(tx, userId, usedRuleIds);

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

    const learnedRules =
      learnedRuleIds.length === 0
        ? []
        : await this.prisma.categorizationRule.findMany({
            where: { id: { in: [...new Set(learnedRuleIds)] }, userId },
            select: {
              id: true,
              pattern: true,
              subcategory: { select: { name: true } },
              counterAccount: { select: { name: true } },
              excludeFromStats: true,
            },
          });

    return { ...(await this.getBatch(userId, batchId)), learnedRules };
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
  /**
   * A soft warning (never a block) when a row being marked as a transfer looks
   * like the other leg of one already recorded a few days apart — the
   * processing-lag case. Exact-date mirrors are excluded because those merge
   * automatically at commit; this only flags the ambiguous near-date ones, so a
   * genuine repeat is never dropped silently and a real mirror never slips
   * through unnoticed. The user decides by Skipping the row or not.
   */
  private async nearDateMirrorWarning(
    batchAccountId: string,
    counterAccountId: string,
    row: { date: Date; amount: number; type: TransactionType },
  ): Promise<string | null> {
    const movingOut = row.type === 'EXPENSE';
    const from = movingOut ? batchAccountId : counterAccountId;
    const to = movingOut ? counterAccountId : batchAccountId;
    const windowMs = TRANSFER_WARN_DAYS * 24 * 60 * 60 * 1000;

    const near = await this.prisma.transaction.findFirst({
      where: {
        type: 'TRANSFER',
        amount: row.amount,
        date: {
          gte: new Date(row.date.getTime() - windowMs),
          lte: new Date(row.date.getTime() + windowMs),
        },
        // Same-date legs auto-merge at commit — no warning needed for those.
        NOT: { date: row.date },
        OR: [
          { accountId: from, counterAccountId: to },
          { accountId: to, counterAccountId: from },
        ],
      },
      select: { date: true },
    });
    if (!near) return null;
    const on = near.date.toISOString().slice(0, 10);
    return `Possible duplicate: a matching transfer is already recorded on ${on}. If it's the same movement posted a few days apart, Skip this row.`;
  }

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

    // Undoing removes the transactions those rules categorized, so the usage
    // counted at commit has to come back off. Without this, commit -> undo ->
    // commit counts the same rows twice.
    // Same three conditions commit counts on, in the same order. Anything less
    // takes usage off a rule that was never credited with it.
    const undoneRuleIds = batch.rows
      .filter(
        (r) =>
          r.predictionSource === 'RULE' && !r.corrected && r.ruleId !== null,
      )
      .map((r) => r.ruleId as string);

    await this.prisma.$transaction([
      this.prisma.importRow.updateMany({
        where: { batchId, transactionId: { not: null } },
        data: { status: 'READY', transactionId: null },
      }),
      ...[...new Set(undoneRuleIds)].map((id) =>
        this.prisma.categorizationRule.updateMany({
          where: { id, userId },
          data: {
            hitCount: {
              decrement: undoneRuleIds.filter((r) => r === id).length,
            },
          },
        }),
      ),
      // Before the delete below, which nulls the link this matches on.
      this.prisma.reminder.deleteMany({
        where: openIousReadFrom({ id: { in: transactionIds } }),
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
   * Everything measurable about one import, for comparing providers and models
   * on the same statement.
   *
   * Deliberately works on an *uncommitted* batch, which accuracyStats cannot:
   * committing a run makes the next run of the same file all duplicates, and it
   * teaches rules from the corrections, so a second model would be scored on a
   * statement the first one already taught the rules for. The honest protocol
   * is import -> review every row -> read this -> discard, repeated per model.
   * `corrected` is written at review time, not at commit, so the ground truth
   * is here before anything is committed.
   *
   * "Kept" means the prediction survived review untouched. That is only a
   * correctness claim if every row was actually looked at, which is on whoever
   * is running the comparison.
   */
  async batchBenchmark(userId: string, batchId: string) {
    const batch = await this.getBatch(userId, batchId);
    const rows = batch.rows;

    // Duplicates never reach a categorizer, so counting them in the denominator
    // would make a statement re-imported against a full ledger look like the
    // model had abstained on everything.
    const duplicates = rows.filter((r) => r.status === 'DUPLICATE');
    const offered = rows.filter((r) => r.status !== 'DUPLICATE');
    const byRule = offered.filter((r) => r.predictionSource === 'RULE');
    const toModel = offered.filter((r) => r.predictionSource !== 'RULE');
    const predicted = toModel.filter((r) => r.predictionSource === 'LLM');

    const kept = (r: (typeof rows)[number]) =>
      !r.corrected && r.predictedSubcategoryId === r.subcategoryId;
    const mean = (values: number[]) =>
      values.length === 0
        ? null
        : values.reduce((a, b) => a + b, 0) / values.length;

    const right = predicted.filter(kept);
    const wrong = predicted.filter((r) => !kept(r));
    const ruleRight = byRule.filter(kept);

    return {
      batchId: batch.id,
      filename: batch.filename,
      status: batch.status,
      provider: batch.provider,
      model: batch.model,
      threshold: batch.threshold,
      extractMs: batch.extractMs,
      categorizeMs: batch.categorizeMs,
      // Per row the model was actually asked about — the comparable rate. A
      // statement that was half duplicates would otherwise look twice as fast.
      msPerModelRow:
        batch.categorizeMs !== null && toModel.length > 0
          ? batch.categorizeMs / toModel.length
          : null,
      rows: {
        total: rows.length,
        duplicates: duplicates.length,
        offered: offered.length,
        matchedByRule: byRule.length,
        sentToModel: toModel.length,
      },
      // Coverage and accuracy are separate axes: a model that answers a third
      // of the rows very well is not the same as one that answers all of them
      // adequately, and a single accuracy number hides which you have.
      coverage: {
        answered: predicted.length,
        abstained: toModel.length - predicted.length,
        rate: toModel.length === 0 ? null : predicted.length / toModel.length,
        // What arrived already applied vs. what the user had to touch.
        autoApplied: predicted.filter(
          (r) => (r.confidence ?? 0) >= batch.threshold,
        ).length,
        sentToReview: predicted.filter(
          (r) => (r.confidence ?? 0) < batch.threshold,
        ).length,
      },
      accuracy: {
        kept: right.length,
        changed: wrong.length,
        rate: predicted.length === 0 ? null : right.length / predicted.length,
      },
      // The calibration question: does a high confidence actually mean a right
      // answer? Small models have been observed returning 1.0 on rows nothing
      // could have known, so the two means being close is itself the finding.
      confidence: {
        whenKept: mean(right.map((r) => r.confidence ?? 0)),
        whenChanged: mean(wrong.map((r) => r.confidence ?? 0)),
      },
      // Rules do the work the model never sees. Reported alongside so a run's
      // headline number is not quietly carried by them.
      rules: {
        matched: byRule.length,
        kept: ruleRight.length,
        rate: byRule.length === 0 ? null : ruleRight.length / byRule.length,
      },
    };
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
        batch: {
          select: {
            id: true,
            filename: true,
            committedAt: true,
            provider: true,
            model: true,
            extractMs: true,
            categorizeMs: true,
          },
        },
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

    // Total rows per batch, including ones the model never predicted, so a
    // timing can be divided by the work actually done.
    const rowCounts = await this.prisma.importRow.groupBy({
      by: ['batchId'],
      where: { batch: { userId, status: 'COMMITTED' } },
      _count: { _all: true },
    });
    const rowsPerBatch = new Map(
      rowCounts.map((r) => [r.batchId, r._count._all]),
    );

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
          provider: list[0].batch.provider,
          model: list[0].batch.model,
          extractMs: list[0].batch.extractMs,
          categorizeMs: list[0].batch.categorizeMs,
          // Every row in the batch, not only the predicted ones tallied above,
          // so seconds-per-row is computed against the real workload.
          rows: rowsPerBatch.get(list[0].batch.id) ?? list.length,
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

    // Ordering only: the review table sorts on this and never prints it, while
    // the skipped notice — the one place a number is shown — keeps the CSV line
    // so it can be looked up in the file. Numbering by staging order is what
    // puts a fee directly after the charge it was taken from, since the two
    // share a line and would otherwise tie.
    const stage = (
      row: Omit<StagedRow, 'dedupeHash' | 'status' | 'rowIndex'>,
    ) => {
      staged.push({
        ...row,
        rowIndex: staged.length + 1,
        dedupeHash: dedupeHash({
          accountId,
          date: row.date,
          type: row.type,
          amount: row.amount,
          normalizedDescription: row.normalizedDescription,
        }),
        status: 'NEEDS_REVIEW',
      });
    };

    records.forEach((raw, index) => {
      const rowIndex = index + 1;
      const date = parseDate(raw[mapping.dateColumn] ?? '', mapping.dateFormat);
      const signedAmount = parseAmount(
        raw[mapping.amountColumn] ?? '',
        mapping.decimalSeparator,
      );
      const tooLarge =
        signedAmount !== null && Math.abs(signedAmount) > PG_INT_MAX;

      // A statement line can carry both a charge and the bank's fee for it, in
      // separate columns. The fee is not part of the amount, so it cannot be
      // folded in: doing so would stop the imported figure matching the
      // statement, and would hide the fee whenever the charge itself is marked
      // an internal transfer — which is exactly when a transfer fee is easiest
      // to lose. It becomes its own expense row instead, categorizable on its
      // own and unaffected by what the charge is later marked as.
      const rawFee = mapping.feeColumn ? (raw[mapping.feeColumn] ?? '') : '';
      const fee = rawFee ? parseAmount(rawFee, mapping.decimalSeparator) : null;
      const feeAmount =
        fee !== null && Math.abs(fee) > 0 && Math.abs(fee) <= PG_INT_MAX
          ? Math.abs(fee)
          : 0;

      // Never booked: no money moved, so neither the charge nor its fee is real.
      // Checked before the amount, so a reverted zero-amount line reports the
      // status rather than the less useful "zero amount".
      const stateHit = Object.entries(raw).find(
        ([col, val]) =>
          col !== mapping.dateColumn &&
          col !== mapping.amountColumn &&
          col !== mapping.descriptionColumn &&
          col !== mapping.feeColumn &&
          SKIP_STATES.has(String(val).trim().toUpperCase()),
      );
      if (date && stateHit) {
        skipped.push({
          rowIndex,
          reason: `not booked (status: ${String(stateHit[1]).trim()})`,
          raw,
        });
        return;
      }

      const description = raw[mapping.descriptionColumn] ?? '';
      // Staged whether or not the charge is: a subscription fee arrives as a
      // zero-amount line whose entire cost sits in the fee column, so tying the
      // fee's fate to the charge's would drop precisely those.
      const stageFee = () => {
        if (!date || feeAmount === 0) return;
        const feeDescription = description ? `Fee · ${description}` : 'Fee';
        stage({
          raw,
          date,
          amount: feeAmount,
          // A fee is money leaving, whichever way the charge itself went.
          type: 'EXPENSE',
          description: feeDescription,
          normalizedDescription: normalizeMerchant(feeDescription),
          predictedSubcategoryId: null,
          confidence: null,
          source: 'NONE',
          predictionSource: null,
          subcategoryId: null,
          counterAccountId: null,
          excludeFromStats: false,
          note: null,
          isFee: true,
        });
      };

      if (!date || signedAmount === null || signedAmount === 0 || tooLarge) {
        skipped.push({
          rowIndex,
          reason: !date
            ? 'unparseable date'
            : signedAmount === null
              ? 'unparseable amount'
              : signedAmount === 0
                ? feeAmount > 0
                  ? 'zero amount — its fee was imported on its own'
                  : 'zero amount'
                : 'amount out of range — check the decimal separator',
          raw,
        });
        stageFee();
        return;
      }

      const isExpense = mapping.negativeIsExpense
        ? signedAmount < 0
        : signedAmount > 0;
      const type: TransactionType = isExpense ? 'EXPENSE' : 'INCOME';
      const amount = Math.abs(signedAmount);

      stage({
        raw,
        date,
        amount,
        type,
        description,
        normalizedDescription: normalizeMerchant(description),
        predictedSubcategoryId: null,
        confidence: null,
        source: 'NONE',
        predictionSource: null,
        subcategoryId: null,
        counterAccountId: null,
        excludeFromStats: false,
        note: null,
      });
      stageFee();
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

  /**
   * Warns about a staged row that looks like something already in the ledger on
   * the same day, for the same amount, in the same direction — but was worded
   * differently, so the fingerprint could not see it.
   *
   * The fingerprint includes the normalized description, which is what makes it
   * safe to exclude a match outright. That same inclusion is why it misses a
   * transaction the user typed in themselves and described in their own words:
   * "Open code monthly subscription" and the bank's "Anomaly" are the same
   * EUR 19.11 charge and share no key at all. A hand-entered transaction has no
   * fingerprint to begin with, so even identical wording would not have matched.
   *
   * Deliberately only a note. Two identical coffees on one day are two coffees,
   * and a rule that silently dropped the second would lose real spending — the
   * failure this whole area is built to avoid. The existing description is
   * quoted because that is the thing the user cannot otherwise recover: it is
   * what they called it when they knew what it was.
   */
  private async flagPossibleDuplicates(
    accountId: string,
    staged: StagedRow[],
  ): Promise<void> {
    // A row the fingerprint already caught is settled; one already carrying a
    // note (a reversal pair) keeps the more specific warning.
    const candidates = staged.filter(
      (row) => row.status !== 'DUPLICATE' && !row.note,
    );
    if (candidates.length === 0) return;

    const times = candidates.map((row) => row.date.getTime());
    const existing = await this.prisma.transaction.findMany({
      where: {
        accountId,
        amount: { in: [...new Set(candidates.map((row) => row.amount))] },
        // Widened by a day at each end so the calendar-day comparison below is
        // never cut off by a timestamped row sitting near a boundary.
        date: {
          gte: new Date(Math.min(...times) - DAY_MS),
          lte: new Date(Math.max(...times) + DAY_MS),
        },
      },
      select: { date: true, amount: true, type: true, description: true },
    });
    if (existing.length === 0) return;

    // Matched on the calendar day, not the timestamp: most imported rows carry
    // the statement's time of day while hand-entered ones sit at midnight, so
    // comparing the instants would never agree.
    const key = (date: Date, type: TransactionType, amount: number) =>
      `${date.toISOString().slice(0, 10)}|${type}|${amount}`;
    const byKey = new Map<string, string>();
    for (const txn of existing) {
      byKey.set(
        key(txn.date, txn.type, txn.amount),
        txn.description?.trim() || 'no description',
      );
    }

    for (const row of candidates) {
      const match = byKey.get(key(row.date, row.type, row.amount));
      if (match === undefined) continue;
      row.note = `Possible duplicate: you already have ${(row.amount / 100).toFixed(2)} on this day in this account, described as "${match}". Skip this row if it is the same charge.`;
    }
  }

  private async categorize(
    userId: string,
    accountId: string,
    staged: StagedRow[],
    threshold: number,
    provider: CategorizationProvider,
  ) {
    // Only duplicates (rows already in the ledger) skip categorization; an
    // in-file repeat is a real charge and gets auto-categorized like any other.
    const pending = staged.filter((r) => r.status !== 'DUPLICATE');
    if (pending.length === 0) return;

    // Retired categories are not candidates. This is the only place the
    // categorizer's list is built, and the two-stage prompt derives its parent
    // list from whatever it is handed — so excluding them here also drops a
    // parent once its last live category is retired, with no special case.
    const subcategories = await this.prisma.subcategory.findMany({
      where: { userId, archivedAt: null },
      select: { id: true, name: true, category: true },
    });

    // 1. Rule pre-pass.
    const rules = await this.prisma.categorizationRule.findMany({
      where: { userId },
      select: {
        id: true,
        pattern: true,
        type: true,
        wholeWord: true,
        subcategoryId: true,
        counterAccountId: true,
        excludeFromStats: true,
      },
    });
    // A rule stores a counter account but no currency, and matches on the
    // description alone, so one learned on a euro account fires on a tenge
    // statement just as happily. The ledger has no cross-currency transfer —
    // assertTransferTarget refuses one on the manual path — and committing one
    // here would write this statement's amount straight into an account
    // denominated in something else, at face value. Resolved in one query up
    // front so the check costs nothing per row.
    const transferTargetIds = [
      ...new Set(
        rules
          .map((r) => r.counterAccountId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const currencyById = new Map<string, string>();
    if (transferTargetIds.length > 0) {
      for (const account of await this.prisma.account.findMany({
        where: { userId, id: { in: [...transferTargetIds, accountId] } },
        select: { id: true, currency: true },
      })) {
        currencyById.set(account.id, account.currency);
      }
    }
    const ownCurrency = currencyById.get(accountId);

    const forProvider: StagedRow[] = [];
    for (const row of pending) {
      const hit = this.rules.match(rules, row.normalizedDescription, row.type);
      if (!hit) {
        forProvider.push(row);
        continue;
      }
      // A fee is money gone to the bank. It is never an internal move and it
      // has no counter account — but it carries the charge's own description
      // ("Fee · To Kamila Jusupova"), and patterns match on substring, so a
      // transfer or internal rule learned from that charge matches the fee
      // too. Committing that credits the counter account with money that
      // never arrived, or drops the fee out of spending entirely, and a rule
      // hit is marked READY so neither would pass the review screen. Hand the
      // row to the categorizer instead: it is spending, and needs a category.
      if (row.isFee && (hit.excludeFromStats || hit.counterAccountId)) {
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
        // An unreadable currency on either side counts as a mismatch: the rule
        // cannot be shown to be safe, and the row is a real transaction that
        // still needs a home. Handed to the categorizer like the fee above —
        // it is spending until something proves it is a transfer.
        if (
          ownCurrency === undefined ||
          currencyById.get(hit.counterAccountId) !== ownCurrency
        ) {
          forProvider.push(row);
          continue;
        }
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
      row.ruleId = hit.ruleId;
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
      provider,
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
    { rememberMapping = true }: { rememberMapping?: boolean } = {},
  ): Promise<ResolvedMapping> {
    if (dto.mapping) {
      // Saving is what makes a mapping the account's remembered format, so a
      // caller that made the mapping up must not trigger it.
      if (!rememberMapping) {
        return dto.mapping as ResolvedMapping;
      }
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
