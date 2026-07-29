-- CreateTable
CREATE TABLE "BudgetPeriod" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "budgetId" TEXT NOT NULL,

    CONSTRAINT "BudgetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetPeriod_budgetId_idx" ON "BudgetPeriod"("budgetId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPeriod_budgetId_period_key" ON "BudgetPeriod"("budgetId", "period");

-- AddForeignKey
ALTER TABLE "BudgetPeriod" ADD CONSTRAINT "BudgetPeriod_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
