-- CreateEnum
CREATE TYPE "public"."NotetakerMeetingContactSource" AS ENUM ('MANUAL', 'CALENDAR');

-- CreateTable
CREATE TABLE "public"."NotetakerMeetingContact" (
    "id" TEXT NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" "public"."NotetakerMeetingContactSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotetakerMeetingContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotetakerMeetingContact_bookingId_idx" ON "public"."NotetakerMeetingContact"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "NotetakerMeetingContact_bookingId_email_key" ON "public"."NotetakerMeetingContact"("bookingId", "email");

-- AddForeignKey
ALTER TABLE "public"."NotetakerMeetingContact" ADD CONSTRAINT "NotetakerMeetingContact_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
