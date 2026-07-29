-- Pinned subcategories are the one-tap shortcuts in the Telegram capture picker.
ALTER TABLE "Subcategory" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
