-- Convert money columns from double precision (major units) to integer minor
-- currency units (cents). Existing values are multiplied by 100.

ALTER TABLE "Account" ALTER COLUMN "balance" DROP DEFAULT;
ALTER TABLE "Account"
  ALTER COLUMN "balance" SET DATA TYPE INTEGER
  USING round(("balance" * 100)::numeric)::integer;
ALTER TABLE "Account" ALTER COLUMN "balance" SET DEFAULT 0;

ALTER TABLE "Transaction"
  ALTER COLUMN "amount" SET DATA TYPE INTEGER
  USING round(("amount" * 100)::numeric)::integer;
