-- Record what each import actually cost, so models can be compared on real
-- statements rather than on a synthetic harness.
--
-- The provider was already stored; the model was not, and neither was any
-- timing. Both are unrecoverable after the fact, which is why past imports keep
-- NULL here rather than being back-filled with a guess.
ALTER TABLE "ImportBatch" ADD COLUMN "model" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "extractMs" INTEGER;
ALTER TABLE "ImportBatch" ADD COLUMN "categorizeMs" INTEGER;
