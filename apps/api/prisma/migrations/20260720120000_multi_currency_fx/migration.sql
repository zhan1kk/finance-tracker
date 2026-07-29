-- Multi-currency support: per-user exchange rates and cached base-currency amounts.

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeRate_userId_currency_date_idx" ON "ExchangeRate"("userId", "currency", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_userId_currency_date_key" ON "ExchangeRate"("userId", "currency", "date");

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Account.initialBalanceBase: pre-FX every account is already in the base currency,
-- so the base-converted opening balance equals the raw opening balance.
ALTER TABLE "Account" ADD COLUMN "initialBalanceBase" INTEGER NOT NULL DEFAULT 0;
UPDATE "Account" SET "initialBalanceBase" = "initialBalance";

-- Transaction.amountBase: add nullable, backfill from amount (pre-FX all amounts were
-- already base currency), then enforce NOT NULL.
ALTER TABLE "Transaction" ADD COLUMN "amountBase" INTEGER;
UPDATE "Transaction" SET "amountBase" = "amount";
ALTER TABLE "Transaction" ALTER COLUMN "amountBase" SET NOT NULL;
