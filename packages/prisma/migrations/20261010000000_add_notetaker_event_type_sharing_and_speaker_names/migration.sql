-- CreateEnum
CREATE TYPE "public"."NotetakerSharingMode" AS ENUM ('HOSTS_ONLY', 'TEAM', 'SELECTED_PEOPLE');

-- AlterEnum
ALTER TYPE "public"."NotetakerActivityAction" ADD VALUE 'SHARED_VIEWED';

-- AlterTable
ALTER TABLE "public"."EventTypeNotetakerSettings" ADD COLUMN     "sharingMode" "public"."NotetakerSharingMode" NOT NULL DEFAULT 'HOSTS_ONLY',
ADD COLUMN     "sharingSetAt" TIMESTAMP(3),
ADD COLUMN     "sharingSetByUserId" INTEGER;

-- AlterTable
ALTER TABLE "public"."NotetakerSession" ADD COLUMN     "colleagueSharingDisclosed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."NotetakerTranscript" ADD COLUMN     "speakerNamesAvailable" BOOLEAN;

-- CreateTable
CREATE TABLE "public"."EventTypeNotetakerSharingMember" (
    "eventTypeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "addedByUserId" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventTypeNotetakerSharingMember_pkey" PRIMARY KEY ("eventTypeId","userId")
);

-- CreateTable
CREATE TABLE "public"."EventTypeNotetakerSharingChange" (
    "id" TEXT NOT NULL,
    "eventTypeId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "actorName" TEXT,
    "previousMode" "public"."NotetakerSharingMode" NOT NULL,
    "newMode" "public"."NotetakerSharingMode" NOT NULL,
    "addedUserNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removedUserNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventTypeNotetakerSharingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventTypeNotetakerSharingMember_userId_idx" ON "public"."EventTypeNotetakerSharingMember"("userId");

-- CreateIndex
CREATE INDEX "EventTypeNotetakerSharingChange_eventTypeId_createdAt_idx" ON "public"."EventTypeNotetakerSharingChange"("eventTypeId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."EventTypeNotetakerSharingMember" ADD CONSTRAINT "EventTypeNotetakerSharingMember_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "public"."EventType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventTypeNotetakerSharingMember" ADD CONSTRAINT "EventTypeNotetakerSharingMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventTypeNotetakerSharingChange" ADD CONSTRAINT "EventTypeNotetakerSharingChange_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "public"."EventType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
