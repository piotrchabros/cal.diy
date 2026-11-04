# Data Model: Meeting Contacts and the Team Webhook for the CRM

**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Two additive migrations, both approved by the user (decision 2). Nothing is renamed or removed; existing rows stay valid.

## New model

### `NotetakerMeetingContact`

| Field | Type | Default | Note |
|-------|------|---------|------|
| `id` | `String` | uuid | |
| `bookingId` | `Int` | | FK to `Booking.id`, cascade on delete |
| `email` | `String` | | normalized (trimmed, lowercase) |
| `name` | `String?` | null | from the calendar invite; null for manual contacts |
| `source` | `NotetakerMeetingContactSource` | | `MANUAL` (host) or `CALENDAR` (owner's invite) |
| `createdAt` | `DateTime` | now | |
| `updatedAt` | `DateTime` | `@updatedAt` | |

Constraints: `@@unique([bookingId, email])`, `@@index([bookingId])`. Back-relation `Booking.notetakerMeetingContacts NotetakerMeetingContact[]`.

Enum `NotetakerMeetingContactSource { MANUAL CALENDAR }`.

Migration `packages/prisma/migrations/20261106000000_add_notetaker_meeting_contact/migration.sql` (sorts after `20261105000001_*` of `specs/003`):

```sql
CREATE TYPE "public"."NotetakerMeetingContactSource" AS ENUM ('MANUAL', 'CALENDAR');
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
CREATE INDEX "NotetakerMeetingContact_bookingId_idx" ON "public"."NotetakerMeetingContact"("bookingId");
CREATE UNIQUE INDEX "NotetakerMeetingContact_bookingId_email_key" ON "public"."NotetakerMeetingContact"("bookingId", "email");
ALTER TABLE "public"."NotetakerMeetingContact" ADD CONSTRAINT "NotetakerMeetingContact_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "public"."Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Semantics of `replaceForSource({ bookingId, source, contacts })`: delete the booking's rows of that `source`, insert the given contacts, skip an email that still exists under the other source (it keeps that row and its name). Callers normalize first. Rows are listed ordered by `createdAt` then `email`, which is the attendee order of the meeting payload.

## Changed model

### `Webhook` (existing)

| Field | Type | Default | Note |
|-------|------|---------|------|
| `includeMemberMeetings` | `Boolean` | false | Team webhooks only: also deliver the members' meetings shared with this team through notetaker sharing. When true, `userId` is null (team-owned) |

Migration `packages/prisma/migrations/20261106000001_add_webhook_include_member_meetings/migration.sql`:

```sql
ALTER TABLE "public"."Webhook" ADD COLUMN "includeMemberMeetings" BOOLEAN NOT NULL DEFAULT false;
```

Invariants enforced by the tRPC handlers (not by the database): `includeMemberMeetings = true` implies `teamId` not null, `platform = false`, `eventTypeId` null, the team is not an organization, and `userId` null. A row with `userId` null, `teamId` set and `eventTypeId` null is "team-owned" and admin-only, whether or not the flag is currently on.

Existing rows keep `false` and their behaviour.

## Transient types (no storage)

- `NotetakerMeetingContactRecord` (`INotetakerMeetingContactRepository.ts`): `{ email, name | null, source }`.
- `MeetingContact` (`lib/meetingContacts.ts`): `{ email, name | null }`.
- `NotetakerMeetingContactDto` and the host-only `meetingContacts` / `transcriptWebhookSent` fields on `NotetakerStateDto` (`packages/lib/dto/NotetakerStateDto.ts`).
- `NotetakerCalendarEvent.attendees?: { email, name | null }[]` (`lib/calendarMeeting.ts`), filled by both calendar gateways; `attendeeEmails` kept for existing callers.
- `MemberSharingTeamInput` (`lib/webhookSharingTeam.ts`): `{ ownerUserId, eventType: { teamId, userId, team: { id, name, parentId } | null, notetakerSettings: { sharingMode, sharingTeam: { id, name } | null } | null } | null, bookingMetadata }`.
- `GetSubscriberOptions.memberSharingTeamIds?: number[]` and `GetSubscribersOptions.memberSharingTeamIds?: number[]` (`packages/features/webhooks/lib`).
- `Webhook.includeMemberMeetings: boolean` on the webhook DTO (`dto/types.ts`), the mapper's input and `IWebhookRepository.findByWebhookId`'s result.
- The meeting payload types and `NotetakerBookingSource` are listed in `specs/003/data-model.md`.
