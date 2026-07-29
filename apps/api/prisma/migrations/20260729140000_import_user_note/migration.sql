-- Personal annotation captured while reviewing an import row ("what was this
-- for"), merged into the transaction's description on commit. Kept apart from
-- "note", which the system overwrites with parse/skip reasons.
ALTER TABLE "ImportRow" ADD COLUMN "userNote" TEXT;
