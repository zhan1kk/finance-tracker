-- Groups for the split ledger: a trip or a flat whose expenses and settlements
-- can be put away together once everyone is square. Existing expenses and
-- settlements stay where they were, "not in a group" (groupId null).

CREATE TABLE "SplitGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "SplitGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SplitGroupMember" (
    "groupId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,

    CONSTRAINT "SplitGroupMember_pkey" PRIMARY KEY ("groupId","friendId")
);

ALTER TABLE "SharedExpense" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Settlement" ADD COLUMN "groupId" TEXT;

CREATE UNIQUE INDEX "SplitGroup_userId_name_key" ON "SplitGroup"("userId", "name");
CREATE INDEX "SplitGroup_userId_idx" ON "SplitGroup"("userId");
CREATE INDEX "SplitGroupMember_friendId_idx" ON "SplitGroupMember"("friendId");
CREATE INDEX "SharedExpense_groupId_idx" ON "SharedExpense"("groupId");
CREATE INDEX "Settlement_groupId_idx" ON "Settlement"("groupId");

ALTER TABLE "SplitGroup" ADD CONSTRAINT "SplitGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SplitGroupMember" ADD CONSTRAINT "SplitGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SplitGroupMember" ADD CONSTRAINT "SplitGroupMember_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SharedExpense" ADD CONSTRAINT "SharedExpense_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
