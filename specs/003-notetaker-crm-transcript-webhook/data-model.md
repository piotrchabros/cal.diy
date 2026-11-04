# Data Model: Notetaker Transcript Webhook for the CRM

**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

One additive change in this feature. No column is renamed or removed; existing rows stay valid. Phase 2 (2026-11-06) added no storage here; the tables it needs (`NotetakerMeetingContact`, `Webhook.includeMemberMeetings`) are specified in [`specs/004`](../004-notetaker-crm-meeting-contacts-team-webhook/data-model.md).

## Changed models

### `NotetakerTranscript` (existing)

| Field | Type | Default | Note |
|-------|------|---------|------|
| `webhookDispatchedAt` | `DateTime?` | null | Set when the single webhook send was claimed. Null: not sent yet (or made before this feature). Never reset |

Migration `packages/prisma/migrations/20261105000001_add_notetaker_transcript_webhook_dispatched_at/migration.sql`:

```sql
ALTER TABLE "public"."NotetakerTranscript" ADD COLUMN "webhookDispatchedAt" TIMESTAMP(3);
```

Transcripts created before the migration have null and, if their summary settles again later, would be sent once. This is accepted; no backfill.

## Claim semantics

`claimWebhookDispatch(id, at)` runs `updateMany` with `where: { id, webhookDispatchedAt: null }`; it returns true when exactly one row changed. Two concurrent settles can therefore never both send. `isWebhookDispatched(id)` reads the marker for the host's booking view (`transcriptWebhookSent` in the notetaker state, phase 2).

## Transient types (no storage)

`packages/lib/dto/NotetakerTranscriptWebhookDto.ts`:

- `NotetakerTranscriptWebhookPassage`: `index`, `speakerKey`, `speakerName | null`, `unknownSpeakerNumber | null`, `startMs`, `endMs`, `text`.
- `NotetakerTranscriptWebhookSummary`: `status` (`READY` | `FAILED`), `language | null`, `overview | null`, `keyPoints`, `decisions`, `actionItems`, `topics`.
- `NotetakerTranscriptWebhookPayload`: `version: 1`, `sessionId`, `transcriptId`, `language | null`, `completeness` (`COMPLETE` | `PARTIAL` | `TRUNCATED`, the existing `NotetakerTranscriptCompletenessDto`), `durationMs`, `speakerNamesAvailable`, `passages`, `summary | null`.
- `NotetakerBookingSource`: `"booking" | "ad_hoc" | "calendar_auto_join"` (phase 2).

`packages/features/notetaker/lib/meetingBookingPayload.ts` (phase 2):

- `NotetakerMeetingWebhookPerson`: `name`, `email`, `timeZone`, `language: { locale }`.
- `NotetakerMeetingBookingPayload`: `type: "notetaker_meeting"`, `uid`, `bookingId`, `eventTypeId: null`, `status`, `title`, `startTime`, `endTime`, `organizer`, `attendees`, `location | null`, `metadata: { videoCallUrl } | undefined`, `source: "ad_hoc" | "calendar_auto_join"`.

`packages/features/webhooks/lib/sendPayload.ts`:

- `EventPayloadType` gains optional `notetaker?: NotetakerTranscriptWebhookPayload` and optional `source?: NotetakerBookingSource`.
- `WebhookPayloadType` union gains `NotetakerMeetingTranscriptPayload = NotetakerMeetingBookingPayload & { notetaker? }` (phase 2).

`packages/features/notetaker/repositories/interfaces/IBookingNotetakerRepository.ts` (phase 2): `NotetakerMeetingForWebhookRecord` = `{ booking: { id, uid, title, startTime, endTime, status, location, metadata }, owner: { name, email, timeZone, locale } | null, contacts: { email, name }[] }`, returned by `findMeetingForWebhook(bookingId)`.
