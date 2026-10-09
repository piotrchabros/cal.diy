# Data Model: Meeting Transcription Notetaker

Related: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md)

## Overview

The feature adds eight Postgres models and nine enums. Passages are stored as rows keyed `(transcriptId, index)`; summary lists are JSON validated by Zod. No audio or video is persisted anywhere (FR-030).

User references are plain nullable integer columns without a foreign key (the `AuditActor` precedent), so `User` gains no relation fields. Only `Booking` and `EventType` gain back-relations.

The change to `packages/prisma/schema.prisma` requires explicit approval before implementation begins (project constitution: schema changes are an "ask first" item). This document does not edit the schema.

### Mapping from spec Key Entities to models

| Spec entity | Model | Requirements |
|---|---|---|
| Booking (existing) | `Booking` (existing, gains back-relations) | FR-001, FR-006 |
| Notetaker Choice | `BookingNotetaker` | FR-001, FR-003, FR-005, FR-006 |
| Event Type Notetaker Default | `EventTypeNotetakerSettings` | FR-004 |
| Notetaker Session | `NotetakerSession` | FR-007, FR-010, FR-011, FR-023, FR-024 |
| Transcript | `NotetakerTranscript` | FR-017 |
| Transcript Passage | `NotetakerTranscriptPassage` | FR-009 |
| Summary | `NotetakerSummary` | FR-018, FR-019, FR-022 |
| Sharing Grant | `NotetakerSharingGrant` | FR-027 |
| Activity Record | `NotetakerActivity` | FR-031 |

### Relationships

```text
EventType 1 ──── 0..1 EventTypeNotetakerSettings        (Cascade)

Booking   1 ──── 0..1 BookingNotetaker                  (Cascade)
Booking   1 ──── 0..* NotetakerSession                  (Cascade)
Booking   1 ──── 0..* NotetakerTranscript               (Cascade)
Booking   1 ──── 0..1 NotetakerSharingGrant             (Cascade)
Booking   1 ──── 0..* NotetakerActivity                 (Cascade)

NotetakerSession    1 ──── 0..1 NotetakerTranscript     (Cascade, sessionId unique)
NotetakerTranscript 1 ──── 0..* NotetakerTranscriptPassage (Cascade)
NotetakerTranscript 1 ──── 0..1 NotetakerSummary        (Cascade, transcriptId unique)

NotetakerActivity.sessionId -> NotetakerSession.id      (soft reference, no FK)
User references (setByUserId, stopRequestedByUserId,
  grantedByUserId, actorUserId)                         (soft references, no FK)
```

## Enums

Values are listed in the design's order.

- `NotetakerSessionStatus`: `SCHEDULED`, `WAITING_TO_BE_ADMITTED`, `TRANSCRIBING`, `PROCESSING`, `READY`, `ENDED_EARLY`, `FAILED` (equals the status set in FR-023)
- `NotetakerOutcomeReason`: `NOT_ADMITTED`, `MEETING_DID_NOT_START`, `NO_SPEECH_DETECTED`, `REMOVED_BY_PARTICIPANT`, `STOPPED_BY_HOST`, `INTERRUPTED`, `LENGTH_LIMIT_REACHED`, `MEETING_LINK_UNUSABLE` (equals the reasons in FR-024)
- `NotetakerPlatform`: `GOOGLE_MEET`, `MICROSOFT_TEAMS`
- `NotetakerBotProvider`: `SELF_HOSTED`, `RECALL`, `FAKE`
- `NotetakerChoiceSource`: `HOST`, `EVENT_TYPE_DEFAULT`
- `NotetakerTranscriptCompleteness`: `COMPLETE`, `PARTIAL`, `TRUNCATED`
- `NotetakerSummaryStatus`: `PENDING`, `READY`, `FAILED`, `NOT_ENOUGH_CONTENT`
- `NotetakerActivityAction`: `ENABLED`, `DISABLED`, `STOPPED`, `SHARED`, `SHARING_REVOKED`, `EXPORTED`, `DELETED`, `SUMMARY_REQUESTED`
- `NotetakerActorType`: `USER`, `PARTICIPANT`, `SYSTEM`

## Entities

### `EventTypeNotetakerSettings`

Event Type Notetaker Default: per event type, whether new bookings start with the notetaker on (FR-004).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| eventTypeId | Int, `@id` | no | | FK to `EventType`, `onDelete: Cascade` |
| enabledByDefault | Boolean | no | false | |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime `@updatedAt` | no | | |

- Relations: one-to-one with `EventType` (`EventType` gains a back-relation); deleting the event type deletes the row.
- Indexes and uniqueness: primary key on `eventTypeId`.
- Validation:
  - `enabledByDefault` can be set to true only when the event type has at least one supported location (US5.5).
  - The default does not alter existing bookings (FR-004).

### `BookingNotetaker`

Notetaker Choice: whether the notetaker is on for a booking, who set it, and its inheritance or series scope (FR-001, FR-003, FR-005, FR-006).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| bookingId | Int, `@id` | no | | FK to `Booking`, Cascade |
| enabled | Boolean | no | | |
| pendingDispatch | Boolean | no | false | |
| source | NotetakerChoiceSource | no | | |
| appliedToSeries | Boolean | no | false | |
| rejoinBlocked | Boolean | no | false | |
| setByUserId | Int (soft reference) | yes | | No foreign key |
| setAt | DateTime | no | now() | |
| attendeesNotifiedAt | DateTime | yes | | Time of the most recent notice send (FR-014) |
| notifiedAttendeeEmails | String[] | no | `[]` | Attendee emails already sent the attendee notice; the per-attendee dedupe key (FR-014) |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime `@updatedAt` | no | | |

- Relations: one-to-one with `Booking` (`Booking` gains a back-relation); deleted with the booking.
- Indexes and uniqueness: primary key on `bookingId`; `@@index([enabled, pendingDispatch])`.
- Validation:
  - No row means off (FR-001).
  - `pendingDispatch` is set true on every off-to-on transition and on carry-over or inheritance. It is cleared by an atomic compare-and-swap (`updateMany where bookingId AND pendingDispatch = true`) when a session is created (FR-008).
  - `rejoinBlocked` is set when a session ends `REMOVED_BY_PARTICIPANT` in any phase, and when it ends `STOPPED_BY_HOST` after admission. It is not set by a pre-admission disable. While true, enabling is refused with reason `REJOIN_BLOCKED` (FR-015).
  - Enabling is refused after `booking.endTime` and for non-hosts (FR-003).
  - A reschedule copies `enabled`, `source`, `appliedToSeries` and `notifiedAttendeeEmails` to the new booking, with `pendingDispatch = enabled` (FR-006).
  - Recipients of the attendee notice are the current `Attendee.email` values, minus this row's `notifiedAttendeeEmails`, minus the emails of bookings sharing the same non-null `recurringEventId`. After a send, the recipients are appended to `notifiedAttendeeEmails` and `attendeesNotifiedAt` is set to now.
  - Disabling does not clear `notifiedAttendeeEmails`, so a re-enable does not re-send the notice to the same attendees.
  - Voiding a choice (a booking in `PENDING` or `AWAITING_HOST` with `startTime <= now`) sets `enabled = false` and `pendingDispatch = false`; every other field is unchanged. It writes activity `DISABLED` with `actorType = SYSTEM` and `detail.reason = "BOOKING_NOT_CONFIRMED"`, and sends no notification and creates no session. A cancelled or rejected booking with no session is not written to; the read model treats its choice as void.
  - When the watchdog deletes a pre-admission session because the booking is no longer `ACCEPTED`, it also voids the choice, with `detail.reason = "BOOKING_NOT_ACTIVE"`.
  - When a booking inherits the event-type default, the `ENABLED` activity has `actorType = SYSTEM` and `detail.source = "EVENT_TYPE_DEFAULT"`.

### `NotetakerSession`

Notetaker Session: one attempt by the notetaker to attend one booking's meeting, with its status and outcome (FR-007, FR-010, FR-011, FR-023, FR-024).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | String `@id @default(uuid())` | no | uuid() | |
| bookingId | Int | no | | FK to `Booking`, Cascade |
| status | NotetakerSessionStatus | no | SCHEDULED | |
| outcomeReason | NotetakerOutcomeReason | yes | | |
| platform | NotetakerPlatform | no | | |
| meetingUrl | String | no | | Resolved at dispatch (FR-007) |
| botProvider | NotetakerBotProvider | no | | |
| externalRef | String | yes | | |
| displayName | String | no | | The name requested in the join request. In Google Meet account mode participants see the bot account's name instead |
| scheduledStartAt | DateTime | no | | |
| dispatchedAt | DateTime | no | now() | |
| joinRequestedAt | DateTime | yes | | |
| admittedAt | DateTime | yes | | |
| noticePostedAt | DateTime | yes | | |
| endedAt | DateTime | yes | | |
| startedLate | Boolean | no | false | |
| rejoinAttempted | Boolean | no | false | |
| interruptedAtMs | Int | yes | | |
| lastHeartbeatAt | DateTime | yes | | |
| lastEventSequence | Int | no | 0 | Event ordering, see state machine |
| stopRequestedAt | DateTime | yes | | |
| stopRequestedByUserId | Int (soft reference) | yes | | No foreign key |
| resultsDeletedAt | DateTime | yes | | Kept after results are deleted (FR-028) |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime `@updatedAt` | no | | |

- Relations: many-to-one with `Booking` (`Booking` gains a back-relation); one-to-zero-or-one with `NotetakerTranscript`; deleted with the booking.
- Indexes and uniqueness: primary key on `id`; `@@index([bookingId])`, `@@index([status])`.
- Validation:
  - At most one non-terminal session per booking, enforced by the compare-and-swap on `BookingNotetaker.pendingDispatch` plus a dispatch precondition (no session in `SCHEDULED`, `WAITING_TO_BE_ADMITTED`, `TRANSCRIBING` or `PROCESSING`) (FR-008).
  - `outcomeReason` is required when status is `FAILED` or `ENDED_EARLY`. It equals `LENGTH_LIMIT_REACHED` when a `READY` transcript is `TRUNCATED`; otherwise it is null.
  - While status is `PROCESSING`, `outcomeReason` may hold a provisional value: on a post-admission `session.ended` the event service sets `PROCESSING` and writes the reason of the "at least one passage" column of the outcome mapping. Finalize counts the passage rows and applies the "no passages" column when the count is zero. No field is added for this.
  - `rejoinAttempted` is set true by `session.reconnecting`, which the bot sends once when it loses the meeting after admission and starts its single rejoin attempt.
  - `interruptedAtMs` is set by `session.reconnecting` to its `atMs`, on the same clock as passage `startMs` (milliseconds since transcription started at admission). `session.ended.interruptedAtMs` then overwrites it: null when the rejoin succeeded, the same value when `endReason` is `INTERRUPTED`. On a watchdog interruption with the field still null, finalize sets it to the last passage's `endMs`, or 0. `session.reconnecting` causes no status change.
  - `startedLate` is true when `dispatchedAt > scheduledStartAt + 60 s`.
  - `meetingUrl` is resolved at dispatch, from the link current at that moment (FR-007).

Phase 11 adds no model, column or enum value. The calendar invite stores nothing.

### `NotetakerTranscript`

Transcript: the ordered record of what was said in one session, saved on the booking (FR-017).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | String `@id @default(uuid())` | no | uuid() | |
| sessionId | String `@unique` | no | | FK to `NotetakerSession`, Cascade |
| bookingId | Int | no | | FK to `Booking`, Cascade |
| language | String (BCP-47) | yes | | |
| completeness | NotetakerTranscriptCompleteness | no | PARTIAL | |
| durationMs | Int | no | 0 | |
| passageCount | Int | no | 0 | |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime `@updatedAt` | no | | |

- Relations: one-to-one with `NotetakerSession`; many-to-one with `Booking` (`Booking` gains a back-relation); one-to-many with `NotetakerTranscriptPassage`; one-to-zero-or-one with `NotetakerSummary`.
- Indexes and uniqueness: `sessionId` unique; `@@index([bookingId])`.
- Validation:
  - Created on the first passages event.
  - The default `PARTIAL` is deliberate: it is correct if the bot dies before finalize (FR-011).
  - Deleted at finalize if it has zero passages, so an empty transcript is never presented.
  - `passageCount` is authoritative as the row count taken at finalize. `durationMs` is `session.ended.durationMs` when that event was accepted, otherwise the maximum passage `endMs`. `session.ended.passageCount` is used only to log a mismatch.

### `NotetakerTranscriptPassage`

Transcript Passage: one continuous utterance with a speaker label, start time and text (FR-009).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| transcriptId | String | no | | FK to `NotetakerTranscript`, Cascade |
| index | Int | no | | |
| speakerKey | String | no | | |
| speakerName | String | yes | | |
| unknownSpeakerNumber | Int | yes | | |
| startMs | Int | no | | |
| endMs | Int | no | | |
| text | String `@db.Text` | no | | |
| language | String | yes | | |

- Relations: many-to-one with `NotetakerTranscript`; deleted with the transcript.
- Indexes and uniqueness: composite primary key `@@id([transcriptId, index])`.
- Validation:
  - Exactly one of `speakerName` and `unknownSpeakerNumber` is non-null.
  - `endMs >= startMs`; `text` is non-empty and at most 1,000 characters.
  - The app enforces only these schema limits: `text` 1 to 1,000 characters, `endMs >= startMs`, and at most 50 passages per event. A violation gets HTTP 400. The 60-second cap on a passage's length is enforced by the bot only; the app does not check it.
  - Inserts use `createMany` with `skipDuplicates`, which makes ingestion idempotent. Display order is by `index`.

### `NotetakerSummary`

Summary: derived from one transcript, holding an overview, key points, decisions and action items (FR-018, FR-019, FR-022).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | String `@id @default(uuid())` | no | uuid() | |
| transcriptId | String `@unique` | no | | FK to `NotetakerTranscript`, Cascade |
| status | NotetakerSummaryStatus | no | PENDING | |
| language | String | yes | | Predominantly spoken language (FR-019) |
| overview | String `@db.Text` | yes | | |
| keyPoints | Json (`string[]`) | no | `[]` | |
| decisions | Json (`string[]`) | no | `[]` | |
| actionItems | Json (`{ text: string, owner: string \| null }[]`) | no | `[]` | |
| model | String | yes | | |
| attempts | Int | no | 0 | |
| failureCode | String | yes | | |
| generatedAt | DateTime | yes | | |
| createdAt | DateTime | no | now() | |
| updatedAt | DateTime `@updatedAt` | no | | |

- Relations: one-to-one with `NotetakerTranscript`; deleted with the transcript.
- Indexes and uniqueness: `transcriptId` unique.
- Validation:
  - The JSON columns are validated by `notetakerSummaryContentSchema`.
  - Regeneration is allowed when status is `FAILED` or when no summary row exists while a transcript does (FR-022). Status `PENDING`, `READY` or `NOT_ENOUGH_CONTENT` refuses it.
  - A summary failure does not change the session status.

### `NotetakerSharingGrant`

Sharing Grant: the revocable record that a host has made a booking's transcript and summary visible to its attendees (FR-027).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| bookingId | Int, `@id` | no | | FK to `Booking`, Cascade |
| grantedByUserId | Int (soft reference) | yes | | No foreign key |
| grantedAt | DateTime | no | now() | |

- Relations: one-to-one with `Booking` (`Booking` gains a back-relation); deleted with the booking.
- Indexes and uniqueness: primary key on `bookingId`.
- Validation:
  - A row means shared with that booking's attendees.
  - Revoking deletes the row.

### `NotetakerActivity`

Activity Record: who enabled, disabled, stopped, shared, exported or deleted, and when (FR-031).

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | String `@id @default(uuid())` | no | uuid() | |
| bookingId | Int | no | | FK to `Booking`, Cascade |
| sessionId | String (soft reference) | yes | | No foreign key |
| action | NotetakerActivityAction | no | | |
| actorType | NotetakerActorType | no | | |
| actorUserId | Int (soft reference) | yes | | No foreign key |
| actorName | String (snapshot) | yes | | |
| detail | Json | yes | | |
| createdAt | DateTime | no | now() | |

- Relations: many-to-one with `Booking` (`Booking` gains a back-relation); deleted with the booking. `BookingAudit` is deliberately not reused: it has no producers wired in this fork, is owner-only, and outlives the booking.
- Indexes and uniqueness: primary key on `id`; `@@index([bookingId, createdAt])`.
- Validation:
  - Append-only.
  - Host-facing history is read by booking (FR-031).
  - `detail.reason` is one of `"BOOKING_NOT_CONFIRMED"`, `"BOOKING_NOT_ACTIVE"` or `"UNSUPPORTED_LOCATION"`. `detail.source` is `"EVENT_TYPE_DEFAULT"`.
  - Changes to an event type's default are not recorded here: they are not booking-level actions and are outside FR-031. The only trace is `EventTypeNotetakerSettings.updatedAt`.

## Session state machine

| From | To | Trigger |
|---|---|---|
| (none) | SCHEDULED | Dispatch: compare-and-swap won, row created `SCHEDULED`, then `gateway.requestJoin` (request timeout 10 s) |
| SCHEDULED | (row deleted) | `requestJoin` fails transiently (timeout, network error, 5xx or 503): the row is deleted and `pendingDispatch` is set true again, so the next sweep retries |
| SCHEDULED | FAILED | `requestJoin` answers 422: outcome reason `MEETING_LINK_UNUSABLE`, `endedAt` = now, `FAILED` notice sent |
| (none) | FAILED | Give-up deadline: at `min(booking.endTime, max(startTime, setAt) + NOTETAKER_NO_SHOW_TIMEOUT_SECONDS)` a still-armed choice gets a `FAILED` session with outcome reason `INTERRUPTED`, `pendingDispatch` is set false, and a `FAILED` notice is sent |
| (none) | FAILED | Dispatch-time eligibility, supported location type but no meeting link: outcome reason `MEETING_LINK_UNUSABLE`, platform from the location type, empty `meetingUrl`, `FAILED` notice sent |
| (none) | (no session) | Dispatch-time eligibility, unsupported location: no session; the choice is turned off (`DISABLED`, `SYSTEM`, `detail.reason = "UNSUPPORTED_LOCATION"`) and a `TURNED_OFF` notice is sent |
| SCHEDULED | WAITING_TO_BE_ADMITTED | `session.join_requested` |
| SCHEDULED, WAITING_TO_BE_ADMITTED | TRANSCRIBING | `session.admitted` |
| SCHEDULED, WAITING_TO_BE_ADMITTED | FAILED | `session.ended` before admission with any end reason other than `STOP_REQUESTED`, with the outcome reason from the "Before admission" column of the outcome mapping; or watchdog heartbeat loss (`INTERRUPTED`) |
| SCHEDULED, WAITING_TO_BE_ADMITTED | (row deleted) | Host disable or booking no longer `ACCEPTED` before admission: stop requested, no transcript, no notice (US1.4). Also `session.ended` with `STOP_REQUESTED` before admission, if the row still exists (200, no notice) |
| TRANSCRIBING | PROCESSING | `session.ended` after admission (any reason), watchdog heartbeat loss, or stop answered 404; finalize is enqueued |
| PROCESSING | READY | At least one passage and the outcome mapping gives `READY`: completeness `COMPLETE`, or `TRUNCATED` with outcome reason `LENGTH_LIMIT_REACHED` |
| PROCESSING | ENDED_EARLY | At least one passage and the outcome mapping gives `ENDED_EARLY`: completeness `PARTIAL` |
| PROCESSING | FAILED | Zero passages: the "After admission, 0 passages" column of the outcome mapping |

### Terminal states

- `READY`, `ENDED_EARLY`, `FAILED`.
- A summary failure does not change the session status.

### Status shown to users

The displayed `status` is decided in this order (FR-023):

1. The choice is enabled and `pendingDispatch` is true: `SCHEDULED`.
2. Otherwise, if a session exists, the latest session's status, whatever `enabled` is.
3. Otherwise `null`.

"Enabled, not pending, no session" is unreachable by invariant; `getState` returns `SCHEDULED` defensively. The stored status of the latest session row (`session.status`) differs from the displayed `status` only when the choice is re-armed after a terminal session.

### Event ordering and idempotency

- Every bot event carries a sequence number. Order of checks: signature, then schema, then session lookup (an unknown session gets HTTP 410), then `sequence <= lastEventSequence` (acknowledged with 200 and ignored), then status (`PROCESSING` or terminal gets 410, nothing changed).
- So a late `session.ended` or late passages after the watchdog moved the session, or after finalize, get 410: the first end wins and the bot leaves. A retried duplicate of an already-accepted `session.ended` gets 200 through the sequence check.
- Events for a `PROCESSING`, terminal or unknown session get HTTP 410. The bot treats 410 as final and does not retry; this includes a `session.ended` for a row that was deleted.
- Passage inserts are idempotent through the `(transcriptId, index)` key and `skipDuplicates`.

## Outcome mapping

"Before admission" means `admittedAt` is null. A schema-valid `session.ended` is never rejected for an unexpected combination: the app normalises it as below and logs a warning. Each cell is session status / `outcomeReason` / transcript completeness.

| `endReason` | Before admission | After admission, at least 1 passage | After admission, 0 passages |
|---|---|---|---|
| `MEETING_ENDED` | `FAILED` / `NOT_ADMITTED` | `READY` / null / `COMPLETE` | `FAILED` / `NO_SPEECH_DETECTED` |
| `ALONE_TIMEOUT` | `FAILED` / `MEETING_DID_NOT_START` (normalised) | `READY` / null / `COMPLETE` | `FAILED` / `NO_SPEECH_DETECTED` |
| `NOT_ADMITTED` | `FAILED` / `NOT_ADMITTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` (normalised) | `FAILED` / `INTERRUPTED` (normalised) |
| `MEETING_DID_NOT_START` | `FAILED` / `MEETING_DID_NOT_START` | `READY` / null / `COMPLETE` (normalised) | `FAILED` / `MEETING_DID_NOT_START` |
| `REMOVED_BY_PARTICIPANT` | `FAILED` / `REMOVED_BY_PARTICIPANT` | `ENDED_EARLY` / `REMOVED_BY_PARTICIPANT` / `PARTIAL` | `FAILED` / `REMOVED_BY_PARTICIPANT` |
| `STOP_REQUESTED` | Row deleted if it still exists; respond 200; no notice | `ENDED_EARLY` / `STOPPED_BY_HOST` / `PARTIAL` | `FAILED` / `STOPPED_BY_HOST` |
| `INTERRUPTED` | `FAILED` / `INTERRUPTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` | `FAILED` / `INTERRUPTED` |
| `LENGTH_LIMIT_REACHED` | `FAILED` / `INTERRUPTED` (normalised) | `READY` / `LENGTH_LIMIT_REACHED` / `TRUNCATED` | `FAILED` / `NO_SPEECH_DETECTED` |
| `MEETING_LINK_UNUSABLE` | `FAILED` / `MEETING_LINK_UNUSABLE` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` (normalised) | `FAILED` / `INTERRUPTED` (normalised) |
| Watchdog heartbeat loss | `FAILED` / `INTERRUPTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` | `FAILED` / `INTERRUPTED` |

Notes:

- Every `FAILED` has no transcript; a zero-passage transcript row is deleted at finalize.
- `rejoinBlocked` is set on `BookingNotetaker` for `REMOVED_BY_PARTICIPANT` in any phase and for `STOP_REQUESTED` after admission. It is not set for a pre-admission disable (FR-015).
- Heartbeat loss means no event for `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS` since the later of `dispatchedAt` and `lastHeartbeatAt`. The watchdog also calls `requestStop` best-effort.
- Every outcome other than `READY` with a null reason records and shows a specific reason (FR-024), and the partial content that exists is preserved and labelled (FR-011).

Provisional `outcomeReason`: no new field is used. On `session.ended` after admission, the event service sets the status to `PROCESSING` and writes a provisional `outcomeReason` taken from the "at least 1 passage" column. Finalize counts the passage rows and applies the "0 passages" column when the count is zero.

## Retention and deletion

- Cascade (FR-029): every table has a foreign key to `Booking`, or to a parent that cascades. Deleting a booking deletes its choice, sessions, transcript, passages, summary, sharing grant and activity. The booking itself cascades from `User`, so deleting the owning account removes everything.
- Host deletion (FR-028): `deleteResults` hard-deletes every transcript of the booking with its passages and summary, sets `NotetakerSession.resultsDeletedAt` on each affected session, and deletes the `NotetakerSharingGrant`. The session rows remain, so the booking still shows what happened. Deletion removes access for everyone, because every read checks that the rows exist.
- Retention (FR-029): transcripts and summaries are kept until a host deletes them or the booking or account is deleted.
- No audio or video (FR-030): nothing is persisted anywhere and no object storage is used. Only text is stored.
- Size expectations: 60 minutes is about 250 to 400 passages (about 60 KB); 4 hours is 1,000 to 3,000 passages (under 0.5 MB). Reads are cursor-paginated (default 200, maximum 500).

## Access rules

`NotetakerAccessService` decides the viewer role on every read.

| Role | Who | Can read transcript and summary |
|---|---|---|
| `HOST` | The organizer (`booking.userId`), or an event-type host/user who is also an attendee of the booking (same rule as `isUserAHost`). Team and organization admins are not hosts. | Always (FR-026) |
| `ATTENDEE` | A signed-in user whose email (primary or verified secondary) matches an `Attendee.email` | Only while a `NotetakerSharingGrant` row exists for the booking (FR-027) |
| Anyone else | | No. Denied with `ErrorWithCode.Factory.Forbidden` |

- Sharing (FR-027): a host creates or deletes the grant row. Revocation is immediate because every read checks the row.
- Attendee links are not tokenised: effectively public links are excluded by the spec.
- Host-only actions: enabling and disabling, stopping, sharing and revoking, deleting results, regenerating the summary, and viewing the activity history (FR-031).
