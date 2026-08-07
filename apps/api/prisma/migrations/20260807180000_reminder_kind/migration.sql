-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'payment';

-- Backfill existing money-owed reminders from their label prefix, so the
-- payments-vs-IOUs split is correct for reminders created before this column.
UPDATE "Reminder" SET "kind" = 'ask' WHERE "label" ILIKE 'ask%';
UPDATE "Reminder" SET "kind" = 'pay' WHERE "label" ILIKE 'pay %';
