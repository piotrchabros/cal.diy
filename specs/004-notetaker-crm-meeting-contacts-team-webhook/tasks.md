# Tasks: Meeting Contacts and the Team Webhook for the CRM

**Input**: Design documents from `/specs/004-notetaker-crm-meeting-contacts-team-webhook/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/

**Tests**: Unit tests sit next to the source (`*.test.ts(x)`) and use the in-memory notetaker repositories, mocked Prisma for handlers and React Testing Library for components; the contact repository integration test (`*.integration-test.ts`) runs only against the scratch database.

**Organization**: Tasks are grouped by the PR of the plan's split (A contacts, B meeting payload, C team flag, D1 lookup and transcript, D2 booking flows and backfill). All tasks were implemented together in the worktree and are checked; the PR letter says where each lands when the work is cut into reviewable PRs.

## Format: `[ID] [P?] [Story] Description (PR)`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task of the same group)
- **[Story]**: US1 to US3 from spec.md; Setup and Polish tasks carry no story label

## Standing rules

- Work only in `/root/cal.diy-crm-webhook`; never touch `/root/cal.diy`. Do not commit. Do not run migrations against any real database; `yarn prisma generate` is allowed.
- Prisma only inside repositories, always `select`. `import type` for types. No `any`. Services throw `ErrorWithCode`, handlers `TRPCError`. Never log emails, secrets or text. Every UI string goes through `t()` into `packages/i18n/locales/en/common.json`.
- Existing team webhooks and every unflagged path keep their behaviour (user decision 3).

---

## Phase 1: Contacts (PR A)

- [x] T101 Add enum `NotetakerMeetingContactSource`, model `NotetakerMeetingContact` and `Booking.notetakerMeetingContacts` to `packages/prisma/schema.prisma`; write `packages/prisma/migrations/20261106000000_add_notetaker_meeting_contact/migration.sql`; run `yarn prisma generate` (A)
- [x] T102 [P] [US1] Tests first, then pure `packages/features/notetaker/lib/meetingContacts.ts`: `normalizeMeetingContacts`, `normalizeMeetingContactEmails`, `isCalendarResourceEmail`, `parseContactEmailInput`, `MAX_MANUAL_CONTACTS` 20, `MAX_CALENDAR_CONTACTS` 50 (A)
- [x] T103 [P] [US1] Add `repositories/interfaces/INotetakerMeetingContactRepository.ts` (`listByBookingId`, `replaceForSource`), `repositories/PrismaNotetakerMeetingContactRepository.ts` with `PrismaNotetakerMeetingContactRepository.integration-test.ts`, the in-memory fake in `tests/InMemoryNotetakerRepositories.ts` (+ test), DI token and `di/PrismaNotetakerMeetingContactRepository.module.ts` (A)
- [x] T104 [US1] `NotetakerAdHocService`: `contactEmails` on `dispatchToMeeting`, new `setMeetingContacts` (host only, ad-hoc or calendar metadata only, `MEETING_CONTACTS_NOT_SUPPORTED`), private `replaceManualContacts` excluding the owner's verified emails; deps `accessService`, `meetingContactRepository`, `findVerifiedEmailsByUserId`; update `di/NotetakerAdHocService.module.ts`, `NotetakerAdHocService.test.ts`, `NotetakerAdHocService.wiring.test.ts` (A)
- [x] T105 [US1] tRPC: `ZNotetakerContactEmailsSchema` and `setMeetingContacts.{schema,handler}.ts` (rate-limited), `contactEmails` on `dispatchToMeeting.schema.ts` and handler, route in `_router.tsx`; tests `setMeetingContacts.handler.test.ts`, `dispatchToMeeting.handler.test.ts`, `_router.test.ts` (A)
- [x] T106 [US2] `lib/calendarMeeting.ts`: optional `attendees: { email, name }[]` on `NotetakerCalendarEvent`; Google gateway requests `displayName` and maps it; Office 365 gateway maps `emailAddress.name`; tests in both gateway test files (A)
- [x] T107 [US2] `NotetakerCalendarAutoJoinService`: `storeCalendarContacts` (owner's calendar only, meeting not ended, exclusions via `calDiyUserEmails`, cap 50, organizer kept unless the owner is the organizer, warn with ids on failure) called from join-or-create, reconcile and touch paths; deps `meetingContactRepository`, `bookingNotetakerRepository`; update its DI module and `NotetakerCalendarAutoJoinService.test.ts` (A)
- [x] T108 [US1] `NotetakerChoiceService.getState`: host-only `meetingContacts` and `transcriptWebhookSent` (`isWebhookDispatched` on `INotetakerTranscriptRepository`, Prisma and in-memory); `NotetakerMeetingContactDto` and the two fields on `NotetakerStateDto`; update the DI module, `NotetakerChoiceService.test.ts`, `quickstartHarness.ts` (A)
- [x] T109 [US1] UI: `apps/web/modules/notetaker/lib/contactEmailInput.ts` (+ test), "Customer emails (optional)" input with hint and errors in `NotetakerAddToMeetingDialog.tsx` (+ test) and `useNotetakerAdHoc.ts`; `NotetakerMeetingContactsEditor.tsx` (+ test) with `useNotetakerMeetingContacts.ts`, rendered by `NotetakerBookingSection.tsx` when `isAdHoc || isCalendarMeeting` (+ test); i18n keys `notetaker_contact_emails_*` (A)

## Phase 2: Meeting payload (PR B; also listed as `specs/003` T013 to T017)

- [x] T201 [P] [US1] `NotetakerBookingSource` in `packages/lib/dto/NotetakerTranscriptWebhookDto.ts`; `source?` on `EventPayloadType`, `NotetakerTranscriptGeneratedPayload` and `NotetakerMeetingTranscriptPayload` in `sendPayload.ts` (B)
- [x] T202 [P] [US1] Tests first, then `packages/features/notetaker/lib/meetingBookingPayload.ts` (`buildNotetakerMeetingBookingPayload`, `resolveNotetakerBookingSource`) (B)
- [x] T203 [US1] `findMeetingForWebhook(bookingId)` and `NotetakerMeetingForWebhookRecord` on `IBookingNotetakerRepository`, Prisma and in-memory implementations (B)
- [x] T204 [US1] Gateway: `source: "booking"` on `buildBookingPayload`, new `buildMeetingPayload`, `deliver` accepting both shapes; `INotetakerTranscriptWebhookGateway.ts`; tests (B)
- [x] T205 [US1] `NotetakerTranscriptWebhookService`: no-event-type bookings build the meeting payload instead of returning; tests (B)

## Phase 3: Team webhook flag (PR C)

- [x] T301 Add `Webhook.includeMemberMeetings Boolean @default(false)` to `schema.prisma`; write `packages/prisma/migrations/20261106000001_add_webhook_include_member_meetings/migration.sql`; run `yarn prisma generate` (C)
- [x] T302 [P] [US3] Expose the flag: `dto/types.ts`, `WebhookOutputMapper.ts` (+ test), `IWebhookRepository.findByWebhookId`, every `select` in `WebhookRepository.ts` (C)
- [x] T303 [US3] `packages/trpc/server/routers/viewer/webhook/memberMeetings.ts`: `assertMemberMeetingsScope`, `assertTeamAdminForMemberMeetings` (C)
- [x] T304 [US3] `create.schema.ts` and `create.handler.ts`: optional flag, guards, no user connection when flagged; `create.handler.test.ts` (C)
- [x] T305 [US3] `edit.schema.ts` and `edit.handler.ts`: admin guard for flagged webhooks, team/event type lock for team-owned or flagged, scope and admin guards for the resulting flag, `userId: null` on enabling, previous flag passed to `updateTriggerForExistingBookings`; `edit.handler.test.ts` (C)
- [x] T306 [US3] `delete.handler.ts`: second lookup for team-owned webhooks with the admin guard, `NOT_FOUND` otherwise; `delete.handler.test.ts` (C)
- [x] T307 [US3] `util.ts` (`createWebhookProcedure`): admin guard for ownerless team webhooks; `_router.test.ts` covering `get`, `edit`, `delete`, `testTrigger` (C)
- [x] T308 [US3] `WebhookRepository.listWebhooks` and `getByViewer`: hide team-owned webhooks from non-admin members; `WebhookRepository.teamOwned.test.ts` (C)
- [x] T309 [US3] UI: switch in `WebhookForm.tsx` (team scope only, disabled with note for non-admins), `webhook-new-view.tsx`, `webhook-edit-view.tsx`, role lookup in the `new` and `[id]` pages; `WebhookForm.memberMeetings.test.tsx`; i18n `webhook_include_member_meetings`, `_description`, `_admin_only` (C)

## Phase 4: Lookup and transcript (PR D1)

- [x] T401 [US3] Tests first, then pure `packages/features/notetaker/lib/webhookSharingTeam.ts`: `resolveMemberSharingTeamIds`, `resolveMemberSharingTeamIdsForSource`, `isTranscriptSharedWithTeam` (D1)
- [x] T402 [US3] `getWebhooks.ts` and `repository/types.ts`: `memberSharingTeamIds` option and OR branch; `getWebhooks.test.ts` (D1)
- [x] T403 [US3] `WebhookRepository.getSubscribers`/`getSubscribersRaw`: seventh `UNION ALL` branch (priority 7); `WebhookRepository.getSubscribers.test.ts` (D1)
- [x] T404 [US3] `NotetakerTranscriptWebhookService`: `membershipLookup` dep, `memberSharingTeamIds` from the booking context under the disclosed/undeleted condition, `findSubscribers({ userId, memberSharingTeamIds })`, dedupe by id; gateway `findSubscribers` passes the option; DI module; tests for TEAM, HOSTS_ONLY, SELECTED_PEOPLE, undisclosed, deleted, owner not a member (D1)

## Phase 5: Booking flows and backfill (PR D2)

- [x] T501 [US3] Selects: `eventType.notetakerSettings { sharingMode, sharingTeam { id, name } }` in `getEventTypesFromDB.ts`, `BookingRepository.ts` (plus `metadata`, `eventType.userId`), `getBookingToDelete.ts`; `notetakerSettings: null` in `defaultEvents.ts` (D2)
- [x] T502 [US3] `RegularBookingService.ts`: exported `getMemberSharingTeamIds` (wraps `MembershipRepository`, `[]` for dynamic events or on error) and `memberSharingTeamIds` on the BOOKING_CREATED/RESCHEDULED, MEETING_STARTED, MEETING_ENDED subscriber options; `handleNewBooking/test/getMemberSharingTeamIds.test.ts` (D2)
- [x] T503 [P] [US3] `handleConfirmation.ts` (BOOKING_CREATED, MEETING_STARTED, MEETING_ENDED) and `handleBookingRequested.ts` (BOOKING_REQUESTED) pass the option; `handleConfirmation.test.ts`, `handleBookingRequested.test.ts` (D2)
- [x] T504 [P] [US3] `handleCancelBooking.ts` (BOOKING_CANCELLED), `confirm.handler.ts` (BOOKING_REJECTED), `requestReschedule.handler.ts` (BOOKING_CANCELLED) pass the option; `handleCancelBooking.test.ts`, `confirm.handler.memberSharing.test.ts`, `requestReschedule.handler.memberSharing.test.ts` (D2)
- [x] T505 [US3] `scheduleTrigger.ts`: `fetchMemberSharingBookings`, flagged branch in `fetchBookingsFromWebhook`, `reconcileMemberMeetingTriggers`, optional `previousIncludeMemberMeetings` on `updateTriggerForExistingBookings`; `scheduleTrigger.memberMeetings.test.ts` (D2)

## Phase 6: Polish

- [x] T601 Run the checks in quickstart.md (`yarn prisma generate`, the Vitest suites, `yarn type-check:ci --force`, `yarn biome check --write`) (all PRs)
- [x] T602 Write this spec folder and amend `specs/003` (contract v2, US2, edge cases, research, data model, plan, quickstart, tasks, checklist) (docs)
- [ ] T603 Cut the worktree into PRs A, B, C, D1, D2 per plan.md, each under 500 lines and 10 code files; deploy the two migrations with the owner's agreement; verify quickstart Scenarios 1 to 4 and the CRM inbox end to end
- [ ] T604 Follow-up (not in scope): remove stale MEETING_* rows of flagged webhooks when a member leaves or sharing is turned off; replace the `PermissionCheckService` stub so plain members cannot read user-owned team webhook secrets; route payment events to flagged webhooks if the CRM needs them

## Dependencies

T101 before T103, T104, T107, T108. T102 before T104, T107. T103 before T104, T107, T108. T104 before T105, T109. T106 before T107. T108 before T109. T201 before T202, T204. T203 before T204. T204 before T205. T301 before T302 to T309. T303 before T304 to T307. T302 before T308, T309. T401 before T402, T404, T502. T402 and T403 before T404 and T501 to T505. T501 before T502 to T504. T505 after T305 (the 4th argument) and T401. T601 after everything; T602 after T601; T603 after T602.
