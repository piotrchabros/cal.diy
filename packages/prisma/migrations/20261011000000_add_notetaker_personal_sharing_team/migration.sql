-- AlterTable
ALTER TABLE "public"."EventTypeNotetakerSettings" ADD COLUMN     "sharingTeamId" INTEGER;

-- AlterTable
ALTER TABLE "public"."EventTypeNotetakerSharingChange" ADD COLUMN     "newTeamName" TEXT,
ADD COLUMN     "previousTeamName" TEXT;

-- CreateIndex
CREATE INDEX "EventTypeNotetakerSettings_sharingTeamId_idx" ON "public"."EventTypeNotetakerSettings"("sharingTeamId");

-- AddForeignKey
ALTER TABLE "public"."EventTypeNotetakerSettings" ADD CONSTRAINT "EventTypeNotetakerSettings_sharingTeamId_fkey" FOREIGN KEY ("sharingTeamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
