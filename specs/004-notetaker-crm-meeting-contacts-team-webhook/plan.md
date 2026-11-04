# Implementation Plan: Meeting Contacts and the Team Webhook for the CRM

**Branch**: `feat/notetaker-crm-webhook` (spec folder `004-notetaker-crm-meeting-contacts-team-webhook`) | **Date**: 2026-11-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-notetaker-crm-meeting-contacts-team-webhook/spec.md`

## Summary

Three pieces, all additive. **Contacts**: a new table `NotetakerMeetingContact` holds customer emails of meetings without an event type, filled by the host (ad-hoc dialog, booking-page editor, `MANUAL`) or from the owner's calendar invite during auto-join (`CALENDAR`); they are never `Attendee` rows. **Meeting payload**: the transcript webhook sends those bookings with a purpose-built payload (owner as organizer, contacts as attendees, `source`); specified in `specs/003` contract v2. **Team webhook**: `Webhook.includeMemberMeetings` lets a team admin opt a team webhook into the members' meetings that are shared with that team; a pure helper resolves the single sharing team per booking, `getWebhooks` gains a `memberSharingTeamIds` branch, every booking sender and the transcript service pass it, and the flagged webhooks are ownerless and admin-only.

Decisions and alternatives: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js 22

**Primary Dependencies**: Prisma 6, Zod 3, tRPC 11, ioctopus DI (`moduleLoader`), existing `packages/features/webhooks` (`getWebhooks`, `scheduleTrigger`, `WebhookRepository`), `MembershipRepository`; no new dependency

**Storage**: PostgreSQL through Prisma; one new table with an enum and a back-relation, one boolean column

**Testing**: Vitest unit tests next to the source with the in-memory notetaker repositories and mocked Prisma for handlers; one integration test for the contact repository (scratch database only); React Testing Library tests for the dialog, editor and webhook form

**Constraints**: additive only; no migration against a real database from this worktree; `yarn prisma generate` allowed; no logging of emails; existing team webhooks unchanged (user decision 3); each PR under 500 lines and 10 code files

## Constitution Check

| Gate | Status | Note |
|------|--------|------|
| Vertical slice | PASS | Contacts and sharing-team logic in `packages/features/notetaker`; webhook flag in `packages/features/webhooks` and the webhook tRPC router; UI in `apps/web/modules` |
| Repositories, DTOs, `select`, DI moduleLoader | PASS | `PrismaNotetakerMeetingContactRepository` with a DI module; `findMeetingForWebhook` in the booking repository; tRPC webhook handlers keep their existing direct-Prisma style |
| Stable public APIs | PASS | tRPC inputs gain optional fields; one new mutation; `GetSubscriberOptions` gains an optional field; `updateTriggerForExistingBookings` gains an optional 4th argument |
| Cross-feature imports | PASS | `scheduleTrigger.ts` and the booking senders import pure helpers from `@calcom/features/notetaker/lib`; no `@calcom/trpc` in features |
| `schema.prisma` change | PASS (approved) | User decision 2 |
| New dependencies | PASS | None |
| PR size (`specs/README.md`) | PASS by split | Five PRs, see below |

## Project Structure

### Documentation (this feature)

```text
specs/004-notetaker-crm-meeting-contacts-team-webhook/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/trpc-notetaker-contacts.md, trpc-webhook-member-meetings.md, member-meetings-delivery.md
└── checklists/requirements.md
```

### Source Code (repository root)

New:

```text
packages/prisma/migrations/20261106000000_add_notetaker_meeting_contact/migration.sql
packages/prisma/migrations/20261106000001_add_webhook_include_member_meetings/migration.sql
packages/features/notetaker/lib/meetingContacts.ts                         # normalization, caps, resource filter (+ test)
packages/features/notetaker/lib/meetingBookingPayload.ts                   # meeting payload builder (+ test)
packages/features/notetaker/lib/webhookSharingTeam.ts                      # resolveMemberSharingTeamIds(+ForSource), isTranscriptSharedWithTeam (+ test)
packages/features/notetaker/repositories/interfaces/INotetakerMeetingContactRepository.ts
packages/features/notetaker/repositories/PrismaNotetakerMeetingContactRepository.ts   # + integration-test
packages/features/notetaker/di/PrismaNotetakerMeetingContactRepository.module.ts
packages/trpc/server/routers/viewer/notetaker/setMeetingContacts.{schema,handler}.ts   # + handler test
packages/trpc/server/routers/viewer/webhook/memberMeetings.ts              # assertMemberMeetingsScope, assertTeamAdminForMemberMeetings
packages/trpc/server/routers/viewer/webhook/{_router,create.handler,edit.handler,delete.handler}.test.ts
packages/features/webhooks/lib/getWebhooks.test.ts
packages/features/webhooks/lib/repository/WebhookRepository.{getSubscribers,teamOwned}.test.ts
packages/features/webhooks/lib/scheduleTrigger.memberMeetings.test.ts
packages/features/webhooks/lib/infrastructure/mappers/WebhookOutputMapper.test.ts
packages/features/bookings/lib/{handleBookingRequested,handleConfirmation}.test.ts
packages/features/bookings/lib/handleNewBooking/test/getMemberSharingTeamIds.test.ts
packages/trpc/server/routers/viewer/bookings/{confirm,requestReschedule}.handler.memberSharing.test.ts
apps/web/modules/notetaker/components/NotetakerMeetingContactsEditor.tsx   # + test
apps/web/modules/notetaker/hooks/useNotetakerMeetingContacts.ts
apps/web/modules/notetaker/lib/contactEmailInput.ts                        # + test
apps/web/modules/webhooks/components/WebhookForm.memberMeetings.test.tsx
```

Modified:

```text
packages/prisma/schema.prisma                                              # table, enum, back-relation, column
packages/lib/dto/NotetakerStateDto.ts                                      # meetingContacts, transcriptWebhookSent (host only)
packages/lib/dto/NotetakerTranscriptWebhookDto.ts                          # NotetakerBookingSource
packages/features/notetaker/lib/calendarMeeting.ts                         # attendees?: { email, name }[]
packages/features/notetaker/calendar/{GoogleCalendarEventsGateway,Office365CalendarEventsGateway}.ts   # displayName / emailAddress.name
packages/features/notetaker/services/NotetakerAdHocService.ts              # contactEmails, setMeetingContacts
packages/features/notetaker/services/NotetakerCalendarAutoJoinService.ts   # storeCalendarContacts
packages/features/notetaker/services/NotetakerChoiceService.ts             # getState host details
packages/features/notetaker/services/NotetakerTranscriptWebhookService.ts  # meeting payload, memberSharingTeamIds
packages/features/notetaker/webhooks/CalcomNotetakerTranscriptWebhookGateway.ts   # buildMeetingPayload, source
packages/features/notetaker/repositories/{PrismaBookingNotetakerRepository,PrismaNotetakerTranscriptRepository}.ts
packages/features/notetaker/repositories/interfaces/{IBookingNotetakerRepository,INotetakerTranscriptRepository}.ts
packages/features/notetaker/di/{tokens,NotetakerAdHocService.module,NotetakerCalendarAutoJoinService.module,NotetakerChoiceService.module}.ts
packages/features/notetaker/tests/{InMemoryNotetakerRepositories,quickstartHarness}.ts
packages/features/webhooks/lib/{getWebhooks,scheduleTrigger,sendPayload}.ts
packages/features/webhooks/lib/repository/{WebhookRepository,types}.ts
packages/features/webhooks/lib/{dto/types,interface/IWebhookRepository,infrastructure/mappers/WebhookOutputMapper}.ts
packages/features/bookings/lib/service/RegularBookingService.ts            # getMemberSharingTeamIds
packages/features/bookings/lib/{handleConfirmation,handleBookingRequested,handleCancelBooking,getBookingToDelete}.ts
packages/features/bookings/lib/handleNewBooking/getEventTypesFromDB.ts     # notetakerSettings select
packages/features/bookings/repositories/BookingRepository.ts               # metadata, eventType.userId, notetakerSettings select
packages/features/eventtypes/lib/defaultEvents.ts                          # notetakerSettings: null
packages/trpc/server/routers/viewer/bookings/{confirm,requestReschedule}.handler.ts
packages/trpc/server/routers/viewer/notetaker/{_router.tsx,dispatchToMeeting.schema.ts,dispatchToMeeting.handler.ts}
packages/trpc/server/routers/viewer/webhook/{util,create.schema,create.handler,edit.schema,edit.handler,delete.handler}.ts
apps/web/modules/notetaker/components/{NotetakerAddToMeetingDialog,NotetakerBookingSection}.tsx
apps/web/modules/notetaker/hooks/useNotetakerAdHoc.ts
apps/web/modules/webhooks/components/WebhookForm.tsx
apps/web/modules/webhooks/views/{webhook-new-view,webhook-edit-view}.tsx
apps/web/app/(use-page-wrapper)/settings/(settings-layout)/developer/webhooks/{new,[id]}/page.tsx
packages/i18n/locales/en/common.json
```

## Design

### Contacts (C1, C2)

- Storage: `NotetakerMeetingContact` (see data-model). Repository `INotetakerMeetingContactRepository`: `listByBookingId` (ordered `createdAt`, `email`), `replaceForSource({ bookingId, source, contacts })` which deletes that source's rows and inserts the new ones, skipping an email already stored under the other source.
- Normalization in `lib/meetingContacts.ts`: trim, lowercase, `emailSchema`, drop excluded emails and calendar resources (`*@resource.calendar.google.com`, `room-*@*.onmicrosoft.com`), dedupe keeping the first name seen, cap (`MAX_MANUAL_CONTACTS` 20, `MAX_CALENDAR_CONTACTS` 50).
- Manual: `NotetakerAdHocService.dispatchToMeeting` accepts `contactEmails` and stores them after creating the booking; `setMeetingContacts({ userId, bookingUid, emails })` requires `assertHost`, refuses bookings whose metadata is neither ad-hoc nor calendar-meeting (`MEETING_CONTACTS_NOT_SUPPORTED`), replaces the `MANUAL` set, excludes the owner's verified emails, and returns the full list. The tRPC mutation is rate-limited (`core`, key `notetaker.setMeetingContacts:<userId>`).
- Calendar: `NotetakerCalendarEvent.attendees` (email plus name) from Google (`displayName` added to the list fields) and Office 365 (`emailAddress.name`); `attendeeEmails` stays. `NotetakerCalendarAutoJoinService.storeCalendarContacts` runs after a meeting is created (`joinOrCreate`) and when an existing meeting is reconciled or touched, only when the swept calendar belongs to the meeting owner and the meeting has not ended. Exclusions: the swept user's email and verified emails, the other participants' primary and verified emails, the organizer when the user is the organizer. The organizer is otherwise added as a contact. Failures are logged as warnings with ids only.
- Exposure: `getState` returns `meetingContacts` and `transcriptWebhookSent` to hosts only. UI: an input in the ad-hoc dialog (comma, semicolon or whitespace separated, validated client-side as `INVALID` or `TOO_MANY`), and `NotetakerMeetingContactsEditor` on the booking page when `state.isAdHoc || state.isCalendarMeeting`, showing calendar contacts read-only with "From calendar invite" and the already-sent note.

### Meeting payload (C3)

Specified in `specs/003` (contract v2, plan step 7, research Decisions 5 and 11). This feature adds `findMeetingForWebhook`, `buildNotetakerMeetingBookingPayload`, `resolveNotetakerBookingSource` and the gateway's `buildMeetingPayload`.

### Team webhook (C4)

- Schema: `Webhook.includeMemberMeetings Boolean @default(false)`; exposed on the webhook DTO, mapper and every repository `select`.
- Guards in `memberMeetings.ts`: `assertMemberMeetingsScope` (team id required, not platform, no event type, team not an organization) and `assertTeamAdminForMemberMeetings` (`getAdminOrOwnerMembership`).
- Create: flag requested → both guards; a flagged webhook does not connect the creating user. Edit: an already-flagged webhook needs the admin guard; a team-owned (ownerless team) or flag-on webhook cannot change `teamId` or `eventTypeId`; flag on after the edit → both guards; enabling sets `userId` null, disabling leaves it null; when the webhook was active, `updateTriggerForExistingBookings` gets the previous flag so MEETING_* rows are reconciled. Delete: an ownerless team webhook is found by a second lookup and deleted only by a team admin; nothing found → `NOT_FOUND`.
- Access: `createWebhookProcedure` (used by `get`, `edit`, `delete`, `testTrigger`, `getByViewer`, `list`) applies the admin guard when the webhook by id has no user and a team. `listWebhooks` hides ownerless team webhooks of teams where the caller is not admin/owner; `getByViewer` filters the team list by the membership role.
- UI: `WebhookForm` shows the switch only with a `teamId` (team scope, not platform), disabled with a note unless `canManageMemberMeetings`; the new and edit pages compute that from the membership role server-side; the views send the flag only when the switch is applicable.
- Matching: `resolveMemberSharingTeamIds({ ownerUserId, eventType, bookingMetadata }, membershipLookup)` derives the sharing team (`deriveNotetakerSharingTeam`: a team event type's team, or the personal event type's chosen team, or the ad-hoc metadata team when there is no event type) and mode (event type settings, `TEAM` for ad-hoc with a team, else `HOSTS_ONLY`), resolves the scope (`resolveNotetakerSharingScope`, which already requires the personal owner to be an accepted member) and, for team event types, checks the booking owner's membership separately. Result `[T]` or `[]`. `resolveMemberSharingTeamIdsForSource` does the same from a `NotetakerBookingContext`.
- Subscriber lookup: `getWebhooks` adds `OR { teamId in memberSharingTeamIds, includeMemberMeetings: true }`; `WebhookRepository.getSubscribersRaw` adds a seventh `UNION ALL` branch (priority 7) and the existing id dedupe applies.
- Senders passing `memberSharingTeamIds`: `RegularBookingService` (`getMemberSharingTeamIds`; BOOKING_CREATED / BOOKING_RESCHEDULED, MEETING_STARTED, MEETING_ENDED options), `handleConfirmation` (BOOKING_CREATED, MEETING_STARTED, MEETING_ENDED), `handleBookingRequested` (BOOKING_REQUESTED), `handleCancelBooking` (BOOKING_CANCELLED), `confirm.handler` (BOOKING_REJECTED), `requestReschedule.handler` (BOOKING_CANCELLED), and `NotetakerTranscriptWebhookService` (RECORDING_TRANSCRIPTION_GENERATED, with the disclosed/undeleted check). The selects feeding them gained `eventType.notetakerSettings` (`getEventTypesFromDB`, `BookingRepository`, `getBookingToDelete`) and `defaultEvents` carries `notetakerSettings: null`.
- Not passing it: BOOKING_PAYMENT_INITIATED / BOOKING_PAID (the `BookingWebhookService` path), no-show and OOO triggers, form submissions. Payment events of shared meetings therefore reach only the member's own webhooks. Seated bookings are covered: `handleSeats` receives the `subscriberOptions` (with `memberSharingTeamIds`) from `RegularBookingService`.
- Backfill: `fetchBookingsFromWebhook` adds `fetchMemberSharingBookings(teamId, excludeIds)` for flagged webhooks (future ACCEPTED bookings of accepted members whose sharing resolves to T), so creating a flagged webhook or adding MEETING_* triggers schedules their rows. `reconcileMemberMeetingTriggers` on a flag toggle schedules or deletes those rows for triggers kept selected.

### Known gaps

1. Stale scheduled rows: when a member leaves the team or the event type's sharing is turned off, already scheduled MEETING_STARTED/ENDED rows of a flagged webhook still fire. Transcripts are unaffected (scope re-checked at send time). Follow-up: a sweep in the `webhookTriggers` cron, or deletion hooks in membership and sharing updates.
2. Pre-existing: `WebhookRepository.PermissionCheckService` is a stub returning true; every accepted member of a team can list user-owned team webhooks, secret included (`getByViewer`, `listWebhooks`). Untouched here by user decision 3; follow-up to wire real PBAC checks.
3. Payment events are not routed to flagged webhooks (see above).

## PR split (`specs/README.md`: < 500 lines, < 10 code files per PR)

| PR | Content | Main files |
|----|---------|------------|
| A | Contacts: schema, migration `20261106000000`, repository + DI, `meetingContacts.ts`, ad-hoc service and tRPC (`contactEmails`, `setMeetingContacts`), calendar gateways and auto-join storage, `getState` fields, dialog input and editor, i18n | `schema.prisma`, `INotetakerMeetingContactRepository.ts`, `PrismaNotetakerMeetingContactRepository.ts`, `meetingContacts.ts`, `NotetakerAdHocService.ts`, `NotetakerCalendarAutoJoinService.ts`, `setMeetingContacts.*`, `NotetakerMeetingContactsEditor.tsx`, `NotetakerAddToMeetingDialog.tsx` (UI may go in A2 if over budget) |
| B | No-event-type transcript payload: `NotetakerBookingSource`, `meetingBookingPayload.ts`, `findMeetingForWebhook`, gateway `buildMeetingPayload` and `source`, service branch, `sendPayload` types | `NotetakerTranscriptWebhookDto.ts`, `meetingBookingPayload.ts`, `IBookingNotetakerRepository.ts`, `PrismaBookingNotetakerRepository.ts`, `CalcomNotetakerTranscriptWebhookGateway.ts`, `NotetakerTranscriptWebhookService.ts`, `sendPayload.ts` |
| C | Team webhook flag: schema, migration `20261106000001`, DTO/mapper/selects, `memberMeetings.ts`, create/edit/delete handlers and schemas, `util.ts` guard, list visibility, form and views, pages, i18n | `schema.prisma`, `dto/types.ts`, `WebhookOutputMapper.ts`, `WebhookRepository.ts` (selects, list filters), `memberMeetings.ts`, `create.handler.ts`, `edit.handler.ts`, `delete.handler.ts`, `util.ts`, `WebhookForm.tsx` |
| D1 | Lookup and transcript: `webhookSharingTeam.ts`, `getWebhooks.memberSharingTeamIds`, raw subscriber branch, transcript service scope | `webhookSharingTeam.ts`, `getWebhooks.ts`, `repository/types.ts`, `WebhookRepository.ts` (UNION branch), `NotetakerTranscriptWebhookService.ts` |
| D2 | Booking flows and backfill: senders, selects, `scheduleTrigger` backfill and reconciliation, edit handler's 4th argument | `RegularBookingService.ts`, `handleConfirmation.ts`, `handleBookingRequested.ts`, `handleCancelBooking.ts`, `confirm.handler.ts`, `requestReschedule.handler.ts`, `getEventTypesFromDB.ts`, `BookingRepository.ts`, `getBookingToDelete.ts`, `scheduleTrigger.ts` |

Order: A and C are independent; B needs A (contacts) ; D1 needs C (flag) and is used by B's service; D2 needs D1. Current worktree state: all five implemented together, uncommitted (74 modified files, 1929 insertions, plus new files).

## Post-design re-check

All gates pass. Deployment-visible changes: the two migrations and `yarn prisma generate`.
