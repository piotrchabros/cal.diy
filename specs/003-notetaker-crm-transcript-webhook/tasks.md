# Tasks: Notetaker Transcript Webhook for the CRM

**Input**: Design documents from `/specs/003-notetaker-crm-transcript-webhook/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Unit tests sit next to the source and use the in-memory repositories; the one integration case runs only against a scratch database.

## Standing rules

- Work only in `/root/cal.diy-crm-webhook`; never touch `/root/cal.diy`. Do not commit. Do not run migrations against any real database; `yarn prisma generate` is allowed.
- Prisma only inside repositories, always `select`. `import type` for types. No `any`. Dynamic `import()` for `CalendarEventBuilder`, `getWebhooks`, `sendOrSchedulePayload` in the gateway. Never log text, secrets or emails.

## Tasks (phase 1, 2026-11-04)

- [x] T001 Add `webhookDispatchedAt DateTime?` to `NotetakerTranscript` in `packages/prisma/schema.prisma` and the migration `packages/prisma/migrations/20261105000001_add_notetaker_transcript_webhook_dispatched_at/migration.sql`; run `yarn prisma generate`
- [x] T002 [P] Add `packages/lib/dto/NotetakerTranscriptWebhookDto.ts` (passage, summary, payload types, version 1)
- [x] T003 [P] Tests first, then pure `packages/features/notetaker/lib/transcriptWebhookPayload.ts` (`buildNotetakerTranscriptWebhookPayload({ transcript, passages, summary })`, summary mapping READY/FAILED else null)
- [x] T004 Add `claimWebhookDispatch(id, at): Promise<boolean>` to `INotetakerTranscriptRepository.ts`, `PrismaNotetakerTranscriptRepository.ts` (with an integration-test case) and `tests/InMemoryNotetakerRepositories.ts`
- [x] T005 [P] Add optional `notetaker?: NotetakerTranscriptWebhookPayload` to `EventPayloadType` in `packages/features/webhooks/lib/sendPayload.ts`
- [x] T006 Add `webhooks/INotetakerTranscriptWebhookGateway.ts` (`findSubscribers`, `buildBookingPayload`, `deliver`) and `webhooks/CalcomNotetakerTranscriptWebhookGateway.ts` with tests
- [x] T007 Tests first (deleted results, no passages, no subscribers, no event type, claim race, delivery failure swallowed), then `services/NotetakerTranscriptWebhookService.ts`
- [x] T008 Add DI: tokens in `di/tokens.ts` and `di/NotetakerTranscriptWebhookGateway.module.ts`, `di/NotetakerTranscriptWebhookService.module.ts`
- [x] T009 Wire `NotetakerFinalizeService.ts` (short transcript, `task-failed`) with its di module and tests
- [x] T010 Wire `NotetakerSummaryService.ts`: private `settle` replacing the three settle-time notify calls, with its di module and tests
- [x] T011 Run `yarn prisma generate`, `TZ=UTC yarn test packages/features/notetaker`, `TZ=UTC yarn test packages/features/webhooks/lib`, `yarn type-check:ci --force`, `yarn biome check --write <changed files>`; record the counts
- [ ] T012 Deploy with the owner's agreement: apply the migration, rebuild, create the user webhooks and the `webhookTriggers` cron per quickstart.md, and verify Scenario 1 end to end with the CRM

## Tasks (phase 2, 2026-11-06, delivered by `specs/004` PR B and PR D1)

- [x] T013 [P] Add `NotetakerBookingSource` to `packages/lib/dto/NotetakerTranscriptWebhookDto.ts`; add `source?` to `EventPayloadType` and the `NotetakerMeetingTranscriptPayload` union member in `sendPayload.ts` (PR B)
- [x] T014 [P] Tests first, then pure `packages/features/notetaker/lib/meetingBookingPayload.ts` (`buildNotetakerMeetingBookingPayload`, `resolveNotetakerBookingSource`) (PR B)
- [x] T015 Add `findMeetingForWebhook(bookingId)` and `NotetakerMeetingForWebhookRecord` to `IBookingNotetakerRepository.ts`, `PrismaBookingNotetakerRepository.ts` and the in-memory fake (PR B)
- [x] T016 Gateway: `buildBookingPayload` adds `source: "booking"`; new `buildMeetingPayload({ bookingId, fallbackVideoCallUrl })`; `deliver` accepts both payload shapes; tests for ad-hoc, calendar, no contacts, missing owner, lookup failure (PR B)
- [x] T017 Service: `eventTypeId === null` builds the meeting payload instead of returning; test (PR B)
- [x] T018 Service: compute `memberSharingTeamIds` from the booking context with `isTranscriptSharedWithTeam` and `resolveMemberSharingTeamIdsForSource`; `findSubscribers({ userId, memberSharingTeamIds })`; deduplicate subscribers by id; tests for TEAM/HOSTS_ONLY/SELECTED_PEOPLE, undisclosed, deleted, owner not a member (PR D1)
- [x] T019 Amend this spec folder: spec.md US1/US2/FR/SC/edge cases/changelog, contracts v2, research Decisions 4, 5 and 11, data-model, plan, quickstart Scenario 4, checklist (docs)

## Dependencies

T001 before T004 and T007. T002 before T003, T006, T007. T003 and T005 before T006. T004, T006 before T007. T007 before T008 to T010. T008 to T010 before T011, then T012. T013 before T014 and T016. T015 before T016. T016 before T017. T018 needs `specs/004` T401 (`webhookSharingTeam.ts`) and T402 (`getWebhooks.memberSharingTeamIds`).
