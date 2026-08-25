-- Opt-in whole-word matching for a categorization rule.
--
-- Rules match a substring of the normalized merchant text, which is right for
-- the patterns learned from corrections: bank statements truncate names, so a
-- learned rule often ends mid-word ("agentur fur wa") and only a substring
-- match will find it again.
--
-- It is wrong for short hand-written keywords, where "cos" also sits inside
-- "tesco stores". Hence a per-rule flag rather than a global change.
--
-- Defaults to false, so every existing rule keeps its exact current behaviour.
ALTER TABLE "CategorizationRule"
  ADD COLUMN "wholeWord" BOOLEAN NOT NULL DEFAULT false;
