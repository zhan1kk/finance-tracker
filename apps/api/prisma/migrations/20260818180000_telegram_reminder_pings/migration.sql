-- Telegram reminder nudges: per-user opt-in and cadence, plus a per-reminder
-- record of the last nudge so a day's job never sends twice.
-- Purely additive: every column is nullable or has a default, so existing rows
-- are untouched and the deploy needs no backfill.
ALTER TABLE "User"
  ADD COLUMN "telegramRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminderLeadDays" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "reminderIntervalDays" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "Reminder" ADD COLUMN "lastPingedOn" TIMESTAMP(3);
