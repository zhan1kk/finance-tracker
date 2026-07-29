-- AlterTable
ALTER TABLE "CategorizationRule" ADD COLUMN     "excludeFromStats" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "excludeFromStats" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "excludeFromStats" BOOLEAN NOT NULL DEFAULT false;
