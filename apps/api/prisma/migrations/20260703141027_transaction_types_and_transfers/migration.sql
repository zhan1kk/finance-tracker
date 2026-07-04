-- Money model v2: explicit transaction types (INCOME / EXPENSE / TRANSFER),
-- transfers between own accounts, reimbursement links, and a persisted
-- initialBalance so account balances can always be recomputed.
--
-- Backfills for existing rows:
--   1. type is derived from the subcategory's category (Income -> INCOME,
--      everything else -> EXPENSE).
--   2. Debts/Savings transactions were balance-neutral under the old rules but
--      count as EXPENSE under the new ones, so their amounts are subtracted
--      from the stored balances to keep them consistent.
--   3. initialBalance is recovered as balance minus the signed sum of the
--      account's transactions.

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "initialBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable (type nullable first; backfilled below, then made required)
ALTER TABLE "Transaction"
  ADD COLUMN "counterAccountId" TEXT,
  ADD COLUMN "parentTransactionId" TEXT,
  ADD COLUMN "type" "TransactionType",
  ALTER COLUMN "subcategoryId" DROP NOT NULL;

-- Backfill 1: derive type from the subcategory's category
UPDATE "Transaction" t
SET "type" = CASE
  WHEN s."category" = 'Income' THEN 'INCOME'::"TransactionType"
  ELSE 'EXPENSE'::"TransactionType"
END
FROM "Subcategory" s
WHERE s."id" = t."subcategoryId";

ALTER TABLE "Transaction" ALTER COLUMN "type" SET NOT NULL;

-- Backfill 2: previously-neutral Debts/Savings now subtract as EXPENSE
UPDATE "Account" a
SET "balance" = a."balance" - fix."total"
FROM (
  SELECT t."accountId", SUM(t."amount")::int AS "total"
  FROM "Transaction" t
  JOIN "Subcategory" s ON s."id" = t."subcategoryId"
  WHERE s."category" IN ('Debts', 'Savings')
  GROUP BY t."accountId"
) fix
WHERE a."id" = fix."accountId";

-- Backfill 3: recover the starting balance from the (now consistent) state
UPDATE "Account" SET "initialBalance" = "balance";

UPDATE "Account" a
SET "initialBalance" = a."initialBalance" - sums."total"
FROM (
  SELECT "accountId",
         SUM(CASE WHEN "type" = 'INCOME' THEN "amount" ELSE -"amount" END)::int AS "total"
  FROM "Transaction"
  GROUP BY "accountId"
) sums
WHERE a."id" = sums."accountId";

-- DropForeignKey (subcategory is now optional: RESTRICT -> SET NULL)
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_subcategoryId_fkey";

-- CreateIndex
CREATE INDEX "Transaction_counterAccountId_idx" ON "Transaction"("counterAccountId");

-- CreateIndex
CREATE INDEX "Transaction_parentTransactionId_idx" ON "Transaction"("parentTransactionId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_parentTransactionId_fkey" FOREIGN KEY ("parentTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
