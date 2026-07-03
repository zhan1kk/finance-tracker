-- Add User + RefreshToken and per-user ownership of Account and Subcategory.
--
-- Existing rows (dev databases only) are assigned to a "demo@local.test" user
-- (password: changeme123) created on the fly. On empty databases (fresh
-- clones, CI, production) no demo user is created.

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- AlterTable (nullable first; backfilled below, then made required)
ALTER TABLE "Account" ADD COLUMN "userId" TEXT;
ALTER TABLE "Subcategory" ADD COLUMN "userId" TEXT;

-- Backfill: assign pre-existing rows to a demo user (dev databases only)
DO $$
DECLARE
  demo_id TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "Account") OR EXISTS (SELECT 1 FROM "Subcategory") THEN
    demo_id := gen_random_uuid()::text;
    INSERT INTO "User" ("id", "email", "passwordHash", "baseCurrency", "updatedAt")
    VALUES (
      demo_id,
      'demo@local.test',
      '$argon2id$v=19$m=65536,t=3,p=4$/fTRcSExMLm3hc3AOkZk5g$Q1Z0wJJdansl9vv7SWFizx572wyR7TR4Xv/nYYc91Yg',
      'EUR',
      CURRENT_TIMESTAMP
    );
    UPDATE "Account" SET "userId" = demo_id WHERE "userId" IS NULL;
    UPDATE "Subcategory" SET "userId" = demo_id WHERE "userId" IS NULL;
  END IF;
END $$;

ALTER TABLE "Account" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Subcategory" ALTER COLUMN "userId" SET NOT NULL;

-- DropIndex (name is now unique per user, not globally)
DROP INDEX "Subcategory_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subcategory_userId_name_key" ON "Subcategory"("userId", "name");

-- CreateIndex
CREATE INDEX "Transaction_accountId_idx" ON "Transaction"("accountId");

-- CreateIndex
CREATE INDEX "Transaction_subcategoryId_idx" ON "Transaction"("subcategoryId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subcategory" ADD CONSTRAINT "Subcategory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
