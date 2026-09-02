-- Optional: the statement column holding a per-transaction fee (Revolut's "Fee").
-- When mapped, a non-zero fee becomes its own expense row instead of being
-- dropped with the rest of the unmapped columns.
ALTER TABLE "AccountImportMapping" ADD COLUMN "feeColumn" TEXT;
