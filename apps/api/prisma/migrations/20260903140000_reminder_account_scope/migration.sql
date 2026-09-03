-- Optional: scope a reminder to one account. Two people sharing a category
-- (both partners' Urban Sports memberships) are told apart by the account the
-- charge lands on, so reconcile can stop advancing one person's reminder when
-- the other one pays. Null keeps the previous behaviour: any account counts.
ALTER TABLE "Reminder" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
