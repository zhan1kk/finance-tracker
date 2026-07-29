-- Rules become direction-aware: the same pattern may map to different targets
-- by transaction direction (an Amazon charge is shopping, an Amazon credit is
-- a refund). Transfer rules get type TRANSFER and match either direction.

ALTER TABLE "CategorizationRule" ADD COLUMN "type" "TransactionType";

-- Backfill existing rules: transfer rules are TRANSFER; subcategory rules take
-- their direction from the subcategory's category.
UPDATE "CategorizationRule" SET "type" = 'TRANSFER' WHERE "counterAccountId" IS NOT NULL;
UPDATE "CategorizationRule" r
SET "type" = CASE WHEN s."category" = 'Income' THEN 'INCOME' ELSE 'EXPENSE' END::"TransactionType"
FROM "Subcategory" s
WHERE r."subcategoryId" = s."id" AND r."type" IS NULL;
-- Exactly-one-target is service-enforced, so nothing should remain; belt and braces.
UPDATE "CategorizationRule" SET "type" = 'EXPENSE' WHERE "type" IS NULL;

ALTER TABLE "CategorizationRule" ALTER COLUMN "type" SET NOT NULL;

-- Uniqueness now includes direction, letting income and expense rules share a pattern.
DROP INDEX "CategorizationRule_userId_pattern_key";
CREATE UNIQUE INDEX "CategorizationRule_userId_pattern_type_key"
  ON "CategorizationRule"("userId", "pattern", "type");
