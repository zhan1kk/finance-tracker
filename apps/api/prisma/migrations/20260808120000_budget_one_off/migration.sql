-- One-off budgets: a budget can apply to a single financial month only.
-- NULL keeps the existing behaviour (recurs every month).
ALTER TABLE "Budget" ADD COLUMN "oneOffPeriod" TEXT;
