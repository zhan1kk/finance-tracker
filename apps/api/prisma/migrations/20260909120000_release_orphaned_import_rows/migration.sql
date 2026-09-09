-- Correct import rows left claiming a transaction that no longer exists.
--
-- Deleting a transaction nulls ImportRow.transactionId through the foreign
-- key, but nothing reset the status, so the row stayed at COMMITTED and its
-- batch went on reporting a row that is not in the ledger. undo() only looks
-- at rows still holding a transactionId, so it could never reach one of these
-- to correct it either.
--
-- COMMITTED with no transaction can only mean a deleted transaction: undo()
-- sets status back to READY when it clears the link. So this matches exactly
-- the affected rows and nothing else. 23 of them in the live database.
--
-- The code no longer creates this state (deleteTransaction releases the row in
-- the same transaction); this is the backfill for the rows that predate it.
UPDATE "ImportRow"
SET status = 'SKIPPED'
WHERE status = 'COMMITTED' AND "transactionId" IS NULL;
