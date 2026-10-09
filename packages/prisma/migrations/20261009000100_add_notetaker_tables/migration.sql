-- CreateEnum
CREATE TYPE "public"."NotetakerSessionStatus" AS ENUM ('SCHEDULED', 'WAITING_TO_BE_ADMITTED', 'TRANSCRIBING', 'PROCESSING', 'READY', 'ENDED_EARLY', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."NotetakerOutcomeReason" AS ENUM ('NOT_ADMITTED', 'MEETING_DID_NOT_START', 'NO_SPEECH_DETECTED', 'REMOVED_BY_PARTICIPANT', 'STOPPED_BY_HOST', 'INTERRUPTED', 'LENGTH_LIMIT_REACHED', 'MEETING_LINK_UNUSABLE');

-- CreateEnum
CREATE TYPE "public"."NotetakerPlatform" AS ENUM ('GOOGLE_MEET', 'MICROSOFT_TEAMS');

-- CreateEnum
CREATE TYPE "public"."NotetakerBotProvider" AS ENUM ('SELF_HOSTED', 'RECALL', 'FAKE');

-- CreateEnum
CREATE TYPE "public"."NotetakerChoiceSource" AS ENUM ('HOST', 'EVENT_TYPE_DEFAULT');

-- CreateEnum
CREATE TYPE "public"."NotetakerTranscriptCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'TRUNCATED');

-- CreateEnum
CREATE TYPE "public"."NotetakerSummaryStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'NOT_ENOUGH_CONTENT');

-- CreateEnum
CREATE TYPE "public"."NotetakerActivityAction" AS ENUM ('ENABLED', 'DISABLED', 'STOPPED', 'SHARED', 'SHARING_REVOKED', 'EXPORTED', 'DELETED', 'SUMMARY_REQUESTED');

-- CreateEnum
CREATE TYPE "public"."NotetakerActorType" AS ENUM ('USER', 'PARTICIPANT', 'SYSTEM');

-- CreateTable
CREATE TABLE "public"."EventTypeNotetakerSettings" (
    "eventTypeId" INTEGER NOT NULL,
    "enabledByDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTypeNotetakerSettings_pkey" PRIMARY KEY ("eventTypeId")
);

-- CreateTable
CREATE TABLE "public"."BookingNotetaker" (
    "bookingId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "pendingDispatch" BOOLEAN NOT NULL DEFAULT false,
    "source" "public"."NotetakerChoiceSource" NOT NULL,
    "appliedToSeries" BOOLEAN NOT NULL DEFAULT false,
    "rejoinBlocked" BOOLEAN NOT NULL DEFAULT false,
    "setByUserId" INTEGER,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attendeesNotifiedAt" TIMESTAMP(3),
    "notifiedAttendeeEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingNotetaker_pkey" PRIMARY KEY ("bookingId")
);

-- CreateTable
CREATE TABLE "public"."NotetakerSession" (
    "id" TEXT NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "status" "public"."NotetakerSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "outcomeReason" "public"."NotetakerOutcomeReason",
    "platform" "public"."NotetakerPlatform" NOT NULL,
    "meetingUrl" TEXT NOT NULL,
    "botProvider" "public"."NotetakerBotProvider" NOT NULL,
    "externalRef" TEXT,
    "displayName" TEXT NOT NULL,
    "scheduledStartAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinRequestedAt" TIMESTAMP(3),
    "admittedAt" TIMESTAMP(3),
    "noticePostedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "startedLate" BOOLEAN NOT NULL DEFAULT false,
    "rejoinAttempted" BOOLEAN NOT NULL DEFAULT false,
    "interruptedAtMs" INTEGER,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastEventSequence" INTEGER NOT NULL DEFAULT 0,
    "stopRequestedAt" TIMESTAMP(3),
    "stopRequestedByUserId" INTEGER,
    "resultsDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotetakerTranscript" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "language" TEXT,
    "completeness" "public"."NotetakerTranscriptCompleteness" NOT NULL DEFAULT 'PARTIAL',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "passageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotetakerTranscriptPassage" (
    "transcriptId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "speakerKey" TEXT NOT NULL,
    "speakerName" TEXT,
    "unknownSpeakerNumber" INTEGER,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,

    CONSTRAINT "NotetakerTranscriptPassage_pkey" PRIMARY KEY ("transcriptId","index")
);

-- CreateTable
CREATE TABLE "public"."NotetakerSummary" (
    "id" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "status" "public"."NotetakerSummaryStatus" NOT NULL DEFAULT 'PENDING',
    "language" TEXT,
    "overview" TEXT,
    "keyPoints" JSONB NOT NULL DEFAULT '[]',
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "actionItems" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotetakerSharingGrant" (
    "bookingId" INTEGER NOT NULL,
    "grantedByUserId" INTEGER,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotetakerSharingGrant_pkey" PRIMARY KEY ("bookingId")
);

-- CreateTable
CREATE TABLE "public"."NotetakerActivity" (
    "id" TEXT NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "sessionId" TEXT,
    "action" "public"."NotetakerActivityAction" NOT NULL,
    "actorType" "public"."NotetakerActorType" NOT NULL,
    "actorUserId" INTEGER,
    "actorName" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotetakerActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingNotetaker_enabled_pendingDispatch_idx" ON "public"."BookingNotetaker"("enabled", "pendingDispatch");

-- CreateIndex
CREATE INDEX "NotetakerSession_bookingId_idx" ON "public"."NotetakerSession"("bookingId");

-- CreateIndex
CREATE INDEX "NotetakerSession_status_idx" ON "public"."NotetakerSession"("status");

-- CreateIndex
CREATE UNIQUE INDEX "NotetakerTranscript_sessionId_key" ON "public"."NotetakerTranscript"("sessionId");

-- CreateIndex
CREATE INDEX "NotetakerTranscript_bookingId_idx" ON "public"."NotetakerTranscript"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "NotetakerSummary_transcriptId_key" ON "public"."NotetakerSummary"("transcriptId");

-- CreateIndex
CREATE INDEX "NotetakerActivity_bookingId_createdAt_idx" ON "public"."NotetakerActivity"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."EventTypeNotetakerSettings" ADD CONSTRAINT "EventTypeNotetakerSettings_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "public"."EventType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BookingNotetaker" ADD CONSTRAINT "BookingNotetaker_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerSession" ADD CONSTRAINT "NotetakerSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerTranscript" ADD CONSTRAINT "NotetakerTranscript_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."NotetakerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerTranscript" ADD CONSTRAINT "NotetakerTranscript_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerTranscriptPassage" ADD CONSTRAINT "NotetakerTranscriptPassage_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "public"."NotetakerTranscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerSummary" ADD CONSTRAINT "NotetakerSummary_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "public"."NotetakerTranscript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerSharingGrant" ADD CONSTRAINT "NotetakerSharingGrant_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerActivity" ADD CONSTRAINT "NotetakerActivity_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

