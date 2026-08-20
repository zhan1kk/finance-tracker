-- Opt-in daily rate sync, per tracked currency. Additive: existing rows default
-- to false, so nobody starts fetching without asking.
ALTER TABLE "CurrencyPreference" ADD COLUMN "autoSync" BOOLEAN NOT NULL DEFAULT false;
