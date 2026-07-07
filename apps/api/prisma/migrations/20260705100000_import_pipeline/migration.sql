-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING_REVIEW', 'COMMITTED', 'UNDONE');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('DUPLICATE', 'READY', 'NEEDS_REVIEW', 'COMMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CategorizationSource" AS ENUM ('RULE', 'LLM', 'MANUAL', 'NONE');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "dedupeHash" TEXT;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "description" TEXT NOT NULL,
    "normalizedDescription" TEXT NOT NULL,
    "dedupeHash" TEXT NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "predictedSubcategoryId" TEXT,
    "confidence" DOUBLE PRECISION,
    "source" "CategorizationSource" NOT NULL DEFAULT 'NONE',
    "subcategoryId" TEXT,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "transactionId" TEXT,
    "batchId" TEXT NOT NULL,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorizationRule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "source" "CategorizationSource" NOT NULL DEFAULT 'MANUAL',
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "subcategoryId" TEXT NOT NULL,

    CONSTRAINT "CategorizationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountImportMapping" (
    "id" TEXT NOT NULL,
    "dateColumn" TEXT NOT NULL,
    "amountColumn" TEXT NOT NULL,
    "descriptionColumn" TEXT NOT NULL,
    "dateFormat" TEXT NOT NULL DEFAULT 'ISO',
    "decimalSeparator" TEXT NOT NULL DEFAULT '.',
    "negativeIsExpense" BOOLEAN NOT NULL DEFAULT true,
    "hasHeader" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "AccountImportMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");

-- CreateIndex
CREATE INDEX "ImportBatch_accountId_idx" ON "ImportBatch"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_transactionId_key" ON "ImportRow"("transactionId");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_idx" ON "ImportRow"("batchId");

-- CreateIndex
CREATE INDEX "ImportRow_dedupeHash_idx" ON "ImportRow"("dedupeHash");

-- CreateIndex
CREATE INDEX "CategorizationRule_userId_idx" ON "CategorizationRule"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CategorizationRule_userId_pattern_key" ON "CategorizationRule"("userId", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "AccountImportMapping_accountId_key" ON "AccountImportMapping"("accountId");

-- CreateIndex
CREATE INDEX "Transaction_accountId_dedupeHash_idx" ON "Transaction"("accountId", "dedupeHash");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_predictedSubcategoryId_fkey" FOREIGN KEY ("predictedSubcategoryId") REFERENCES "Subcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorizationRule" ADD CONSTRAINT "CategorizationRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorizationRule" ADD CONSTRAINT "CategorizationRule_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountImportMapping" ADD CONSTRAINT "AccountImportMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountImportMapping" ADD CONSTRAINT "AccountImportMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

