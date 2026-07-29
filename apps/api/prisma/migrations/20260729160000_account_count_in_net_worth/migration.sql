-- Lets a foreign "pocket" account (e.g. a KZT account) be excluded from the
-- base-currency net worth while its spending still counts in the stats.
-- Defaults to true, preserving current behaviour for every existing account.
ALTER TABLE "Account" ADD COLUMN "countInNetWorth" BOOLEAN NOT NULL DEFAULT true;
