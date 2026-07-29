-- Freezes who made an import row's prediction (RULE/LLM). `source` records who
-- decided the final value and is overwritten to MANUAL on review, which was
-- silently excluding every reviewed row from the accuracy metric — corrected
-- (i.e. wrong) predictions left the denominator, inflating accuracy.

ALTER TABLE "ImportRow" ADD COLUMN "predictionSource" "CategorizationSource";

-- Backfill. Unreviewed rows still carry the original source. Reviewed rows
-- (now MANUAL) with a prediction are attributed by confidence: rule hits are
-- always exactly 1, provider predictions are below.
UPDATE "ImportRow" SET "predictionSource" = "source" WHERE "source" IN ('RULE', 'LLM');
UPDATE "ImportRow"
SET "predictionSource" = CASE WHEN "confidence" = 1 THEN 'RULE' ELSE 'LLM' END::"CategorizationSource"
WHERE "predictionSource" IS NULL
  AND "source" = 'MANUAL'
  AND "predictedSubcategoryId" IS NOT NULL;
