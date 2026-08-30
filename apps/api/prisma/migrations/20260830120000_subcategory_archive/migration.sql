-- Retire a category without deleting it: `archivedAt` set means it is no longer
-- offered to the categorizer or in the pickers. Nullable with no default, so
-- every existing row is active and no historical total moves.
ALTER TABLE "Subcategory" ADD COLUMN "archivedAt" TIMESTAMP(3);
