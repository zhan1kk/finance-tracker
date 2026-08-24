-- Anchor day for a reminder's schedule, so advancing a due date past a short
-- month returns to the original day (31 Jan -> 28 Feb -> 31 Mar) instead of
-- sagging to the 28th for good.
--
-- Additive and nullable: existing reminders keep working, and the settlement
-- code falls back to the due date's own day when this is null.
ALTER TABLE "Reminder" ADD COLUMN "dueAnchorDay" INTEGER;

-- Backfill from the current due date. This is the best available guess: a
-- reminder that already sagged through a short month has lost its original day,
-- so it anchors to where it is now rather than being invented.
UPDATE "Reminder"
SET "dueAnchorDay" = EXTRACT(DAY FROM "dueDate")::INTEGER
WHERE "dueDate" IS NOT NULL;
