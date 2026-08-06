-- CreateTable
CREATE TABLE "CurrencyPreference" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "spreadPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "CurrencyPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CurrencyPreference_userId_currency_key" ON "CurrencyPreference"("userId", "currency");

-- AddForeignKey
ALTER TABLE "CurrencyPreference" ADD CONSTRAINT "CurrencyPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
