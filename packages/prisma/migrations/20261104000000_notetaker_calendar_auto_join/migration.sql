-- AlterEnum
ALTER TYPE "public"."NotetakerChoiceSource" ADD VALUE 'CALENDAR_AUTO_JOIN';

-- CreateTable
CREATE TABLE "public"."NotetakerCalendarAutoJoin" (
    "selectedCalendarId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sharingTeamId" INTEGER,
    "lastPolledAt" TIMESTAMP(3),
    "lastPollError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerCalendarAutoJoin_pkey" PRIMARY KEY ("selectedCalendarId")
);

-- CreateTable
CREATE TABLE "public"."NotetakerCalendarMeeting" (
    "id" TEXT NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "meetingKey" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "iCalUID" TEXT,
    "ownerUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerCalendarMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotetakerCalendarMeetingParticipant" (
    "meetingId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "selectedCalendarId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "NotetakerCalendarMeetingParticipant_pkey" PRIMARY KEY ("meetingId","userId")
);

-- CreateIndex
CREATE INDEX "NotetakerCalendarAutoJoin_enabled_lastPolledAt_idx" ON "public"."NotetakerCalendarAutoJoin"("enabled", "lastPolledAt");

-- CreateIndex
CREATE INDEX "NotetakerCalendarAutoJoin_userId_idx" ON "public"."NotetakerCalendarAutoJoin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotetakerCalendarMeeting_bookingId_key" ON "public"."NotetakerCalendarMeeting"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "NotetakerCalendarMeeting_meetingKey_startTime_key" ON "public"."NotetakerCalendarMeeting"("meetingKey", "startTime");

-- CreateIndex
CREATE INDEX "NotetakerCalendarMeetingParticipant_selectedCalendarId_exte_idx" ON "public"."NotetakerCalendarMeetingParticipant"("selectedCalendarId", "externalEventId");

-- CreateIndex
CREATE INDEX "NotetakerCalendarMeetingParticipant_userId_idx" ON "public"."NotetakerCalendarMeetingParticipant"("userId");

-- CreateIndex
CREATE INDEX "NotetakerSession_meetingUrl_status_idx" ON "public"."NotetakerSession"("meetingUrl", "status");

-- AddForeignKey
ALTER TABLE "public"."NotetakerCalendarAutoJoin" ADD CONSTRAINT "NotetakerCalendarAutoJoin_selectedCalendarId_fkey" FOREIGN KEY ("selectedCalendarId") REFERENCES "public"."SelectedCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerCalendarAutoJoin" ADD CONSTRAINT "NotetakerCalendarAutoJoin_sharingTeamId_fkey" FOREIGN KEY ("sharingTeamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerCalendarMeeting" ADD CONSTRAINT "NotetakerCalendarMeeting_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotetakerCalendarMeetingParticipant" ADD CONSTRAINT "NotetakerCalendarMeetingParticipant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "public"."NotetakerCalendarMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed feature flag
INSERT INTO "Feature" ("slug", "enabled", "type", "description", "createdAt", "updatedAt")
VALUES ('notetaker-calendar-auto-join', false, 'OPERATIONAL', 'Let the notetaker join meetings from selected calendars automatically', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
