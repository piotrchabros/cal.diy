# Implementation Plan: Notetaker Transcript Webhook for the CRM

**Branch**: `feat/notetaker-crm-webhook` (spec folder `003-notetaker-crm-transcript-webhook`) | **Date**: 2026-11-04, amended 2026-11-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-notetaker-crm-transcript-webhook/spec.md`

## Summary

When a notetaker transcript settles, a new service sends the existing trigger `RECORDING_TRANSCRIPTION_GENERATED` to the booking owner's user-level webhooks and, when the meeting is shared with a whole team, to that team's webhooks that opted into member meetings, with the booking payload (or, for bookings without an event type, a meeting payload) plus an inline `notetaker` block. An atomic claim on a new nullable column makes it once-per-transcript. The receiving side is the Open Mercato `webhook_calcom` module (see spec.md, companion change). Phase 2 items are marked; their own mechanics (contacts, the webhook flag, the sharing-team lookup) are planned in `specs/004`.

Decisions and alternatives: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js 22

**Primary Dependencies**: Prisma 6, Zod 3, ioctopus DI (`moduleLoader`), existing `packages/features/webhooks` (`getWebhooks`, `sendOrSchedulePayload`), `CalendarEventBuilder`; no new dependency

**Storage**: PostgreSQL through Prisma; one additive nullable column

**Testing**: Vitest unit tests with the in-memory notetaker repositories; one integration-test case for the claim (scratch database only)

**Constraints**: additive only; production runs the sync tasker and direct webhook send (no retry); no real-database migration from this worktree; the service never throws and never logs text

## Constitution Check

| Gate | Status | Note |
|------|--------|------|
| Vertical slice | PASS | Logic in `packages/features/notetaker`; DTO in `packages/lib/dto` |
| Repositories, DTOs, `select`, DI moduleLoader | PASS | Claim lives in `PrismaNotetakerTranscriptRepository`; two DI modules |
| Stable public APIs | PASS | `EventPayloadType` gains optional fields; `WebhookPayloadType` gains a union member |
| Cross-feature imports | PASS | Webhook helpers reached through a gateway with dynamic `import()`, as `NotetakerTaskService` does |
| `schema.prisma` change | PASS (approved) | One nullable column, approved by the user |
| New dependencies | PASS | None |

## Project Structure

### Documentation (this feature)

```text
specs/003-notetaker-crm-transcript-webhook/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/transcript-webhook.md
└── checklists/requirements.md
```

### Source Code (repository root)

New:

```text
packages/prisma/migrations/20261105000001_add_notetaker_transcript_webhook_dispatched_at/migration.sql
packages/lib/dto/NotetakerTranscriptWebhookDto.ts                     # + NotetakerBookingSource (phase 2)
packages/features/notetaker/lib/transcriptWebhookPayload.ts            # pure builder + test
packages/features/notetaker/lib/meetingBookingPayload.ts               # pure meeting payload builder + test (phase 2)
packages/features/notetaker/webhooks/INotetakerTranscriptWebhookGateway.ts
packages/features/notetaker/webhooks/CalcomNotetakerTranscriptWebhookGateway.ts   # + test
packages/features/notetaker/services/NotetakerTranscriptWebhookService.ts         # + test
packages/features/notetaker/di/NotetakerTranscriptWebhookGateway.module.ts
packages/features/notetaker/di/NotetakerTranscriptWebhookService.module.ts
```

Modified:

```text
packages/prisma/schema.prisma                                   # column
packages/features/webhooks/lib/sendPayload.ts                   # optional notetaker + source fields, meeting payload union member
packages/features/notetaker/repositories/interfaces/INotetakerTranscriptRepository.ts
packages/features/notetaker/repositories/PrismaNotetakerTranscriptRepository.ts   # claimWebhookDispatch, isWebhookDispatched (+ integration case)
packages/features/notetaker/repositories/interfaces/IBookingNotetakerRepository.ts  # findMeetingForWebhook (phase 2)
packages/features/notetaker/repositories/PrismaBookingNotetakerRepository.ts        # findMeetingForWebhook (phase 2)
packages/features/notetaker/tests/InMemoryNotetakerRepositories.ts
packages/features/notetaker/di/tokens.ts
packages/features/notetaker/services/NotetakerFinalizeService.ts (+ di module, test)
packages/features/notetaker/services/NotetakerSummaryService.ts (+ di module, test)
```

### Service flow (`sendOnce({ transcriptId })`, never throws)

1. Load the transcript; missing: return.
2. Session `resultsDeletedAt` set: return.
3. Passages empty: return.
4. Load the booking (`findByBookingIdIncludeBooking`); `userId` null: return. *(phase 2: no event type no longer returns.)*
5. *(phase 2)* `memberSharingTeamIds` = `[T]` when `isTranscriptSharedWithTeam(session)` (disclosed and not deleted) and `resolveMemberSharingTeamIdsForSource({ ownerUserId, source: booking }, membershipLookup)` resolves scope `TEAM` with the owner an accepted member; else `[]`.
6. `findSubscribers({ userId, memberSharingTeamIds })` (nulls for event type, team, org, OAuth client); deduplicate by id; none: return without claiming.
7. Build the booking part before claiming. Event type present: `getBookingForCalEventBuilder` then `CalendarEventBuilder.fromBooking(b).build()`, plus `bookingId`, `eventTypeId`, `status`, `metadata.videoCallUrl` (from the event, else booking metadata, else `session.meetingUrl`), `location`, `source: "booking"`. *(phase 2)* No event type: `findMeetingForWebhook(bookingId)` then `buildNotetakerMeetingBookingPayload` (owner, contacts, `fallbackVideoCallUrl: session.meetingUrl`); owner missing: warn with ids and return. Then add the `notetaker` block.
8. `claimWebhookDispatch`; lost: return.
9. One `createdAt`; per subscriber `sendOrSchedulePayload(secret, "RECORDING_TRANSCRIPTION_GENERATED", createdAt, subscriber, payload)` in its own try/catch; log attempted/failed counts.

### Call sites

- `NotetakerFinalizeService`: after `setStatus(NOT_ENOUGH_CONTENT)` for short transcripts, and after `generateSummary` returns `runId === "task-failed"`.
- `NotetakerSummaryService.generate`: a private `settle(transcript, requestedByUserId)` (existing automatic notification plus `sendOnce`) replaces the three settle-time notify calls (NOT_ENOUGH_CONTENT guard, READY saved, FAILED settled when non-retryable or attempts >= 3).

## Post-design re-check

All gates still pass. The only deployment-visible change of this feature is the migration, applied by the owner at deployment. Phase 2 adds two more migrations, listed in `specs/004`.

## Open items

- Cron for `MEETING_ENDED` is deployed outside this change (quickstart).
- No retry on delivery failure; revisit if production enables the webhook tasker.
