-- Rules and staged import rows can target a transfer between own accounts
-- instead of a subcategory (exactly one target is set; enforced in the service).


-- DropForeignKey
ALTER TABLE "CategorizationRule" DROP CONSTRAINT "CategorizationRule_subcategoryId_fkey";

-- AlterTable
ALTER TABLE "CategorizationRule" ADD COLUMN     "counterAccountId" TEXT,
ALTER COLUMN "subcategoryId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "counterAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorizationRule" ADD CONSTRAINT "CategorizationRule_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategorizationRule" ADD CONSTRAINT "CategorizationRule_counterAccountId_fkey" FOREIGN KEY ("counterAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

