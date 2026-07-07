-- Telegram quick-capture bot (Phase 3.5): chat linking + default capture account.

ALTER TABLE "User"
  ADD COLUMN "telegramChatId" TEXT,
  ADD COLUMN "telegramLinkCodeHash" TEXT,
  ADD COLUMN "telegramLinkCodeExpiresAt" TIMESTAMP(3),
  ADD COLUMN "defaultAccountId" TEXT;

CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");
CREATE UNIQUE INDEX "User_telegramLinkCodeHash_key" ON "User"("telegramLinkCodeHash");

ALTER TABLE "User" ADD CONSTRAINT "User_defaultAccountId_fkey"
  FOREIGN KEY ("defaultAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
