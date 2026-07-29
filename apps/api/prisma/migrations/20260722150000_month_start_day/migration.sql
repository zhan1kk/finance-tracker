-- Financial months: the day a month begins for reporting (1 = calendar months).
ALTER TABLE "User" ADD COLUMN "monthStartDay" INTEGER NOT NULL DEFAULT 1;
