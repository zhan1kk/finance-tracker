-- Deleting a reminder hides it instead of removing the row. A scan reads one
-- reminder per source transaction, and it knows a transaction is taken only
-- because a reminder row points at it — so a hard delete freed the transaction
-- and the next scan recreated the reminder the user had just deleted.
ALTER TABLE "Reminder" ADD COLUMN "deletedAt" TIMESTAMP(3);
