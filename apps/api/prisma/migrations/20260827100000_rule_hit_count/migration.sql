-- Track which rule categorized an import row, so committing a batch can count
-- how often a rule is actually used.
ALTER TABLE "ImportRow" ADD COLUMN "ruleId" TEXT;

-- hitCount changes meaning here. It used to be written only by the upsert that
-- learns a rule from a correction, so it counted corrections: a hand-written
-- rule sat at 0 forever and a learned one at 1, because once the rule exists it
-- handles that merchant and no further corrections happen. The Rules page
-- showed it as "Times used", which it never was.
--
-- From now on it counts committed transactions the rule categorized and the
-- user kept. The old values cannot be converted into that, so they are reset
-- rather than left to mean two different things at once.
UPDATE "CategorizationRule" SET "hitCount" = 0;
