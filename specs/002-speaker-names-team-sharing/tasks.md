# Tasks: Notetaker Speaker Names and Team Sharing

**Input**: Design documents from `/specs/002-speaker-names-team-sharing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/

**Tests**: Test tasks are included. The constitution (Principle III) requires at least 80% coverage on new code. Unit tests sit next to the source as `*.test.ts` and use the in-memory repositories or `FakeMeetingPage`; integration tests (`*.integration-test.ts`) and the E2E file run only against the scratch database.

**Organization**: Tasks are grouped by user story. Each task ends with the delivery group of the plan it belongs to, for example `(A2)`; one PR per group.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task of the same phase)
- **[Story]**: US1 to US4 from spec.md; Setup, Foundational and Polish tasks carry no story label
- Every task names the exact file path(s) it creates or changes

## Path Conventions and Standing Rules

- Paths are relative to the repository root.
- Bot: `apps/notetaker-bot/`. Feature slice: `packages/features/notetaker/`. DTOs and wire contract: `packages/lib/dto/`, `packages/lib/notetaker/botContract.ts`. tRPC: `packages/trpc/server/routers/viewer/notetaker/`. Web: `apps/web/modules/notetaker/`.
- Prisma only inside repositories, always `select`, never `include`. Services throw `ErrorWithCode`, never `TRPCError`. No `as any`. `import type` for types. No barrel imports. `packages/features` never imports `@calcom/trpc`. Comments explain why only. Every UI string goes through `t()` and into `packages/i18n/locales/en/common.json`.
- This checkout serves a live site and its `.env` points at the live database: no `yarn build`, `next build` or `next dev` in `apps/web`, no Prisma migrate or db command, and no database-writing test against it. Integration and E2E use the scratch container `caldiy-e2e-pg` (127.0.0.1:5547) only. `yarn prisma generate` is allowed.
- Names not fixed by the design documents (repository method names, DI module file names, i18n keys) follow the house patterns in `agents/rules/` and the neighbouring notetaker files.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the measurement tool and the shared schema change that both parts need.

- [X] T001 Extend the probe page script in `apps/notetaker-bot/scripts/meetProbePageScript.ts` and its types in `apps/notetaker-bot/scripts/meetProbeTypes.ts` to record per sample, with a per-run random salt and SHA-256, a hash of each top-level tile's `data-participant-id` and `data-ssrc` values, and per audio receiver the hashed CSRC and SSRC ids with `audioLevel` and `timestamp` minus `Date.now()`; record which tile class tokens were added or removed since the previous sample. No raw id, name, audio or chat may be recorded; update `apps/notetaker-bot/scripts/meetProbePageScript.test.ts` and `apps/notetaker-bot/scripts/meetProbeRedaction.test.ts` to prove it (A0)
- [X] T002 Add three verdicts to `apps/notetaker-bot/scripts/meetProbeReport.ts` with tests in `apps/notetaker-bot/scripts/meetProbeReport.test.ts`: Q1 "a tile's source hash equals a receiver source whose level rises above 0.05 while that tile is the only one active", Q2 "a tile class token or attribute toggles with speech at least twice as often as in silence, named in the report", Q3 "receiver source timestamps are within 1000 ms of the page clock"; each verdict is supported, excluded or inconclusive with the counts behind it (A0)
- [X] T003 Document the two-minute speech protocol (who speaks when, what participants are told, the command) as a new section in `apps/notetaker-bot/docs/speaker-attribution-spike.md` and reference it from `apps/notetaker-bot/docs/smoke-test-google-meet.md` section 12 (A0)
- [ ] T004 Run the measurement in a real Google Meet with two speakers per quickstart Scenario 1 (needs the owner and a second person; participants told beforehand), write the three verdicts and the chosen signal order into `apps/notetaker-bot/docs/speaker-attribution-spike.md` and `apps/notetaker-bot/docs/verification-status.md`; if Q1 and Q2 are both excluded, Part A delivers only T012 to T015; skip T016 to T023 and report to the owner (A0-run)
- [X] T005 Add to `packages/prisma/schema.prisma`: enum `NotetakerSharingMode { HOSTS_ONLY TEAM SELECTED_PEOPLE }`; value `SHARED_VIEWED` on `NotetakerActivityAction`; on `EventTypeNotetakerSettings` the fields `sharingMode NotetakerSharingMode @default(HOSTS_ONLY)`, `sharingSetByUserId Int?`, `sharingSetAt DateTime?`; on `NotetakerSession` the field `colleagueSharingDisclosed Boolean @default(false)`; on `NotetakerTranscript` the field `speakerNamesAvailable Boolean?`; model `EventTypeNotetakerSharingMember` (`eventTypeId Int`, `userId Int`, `addedByUserId Int?`, `addedAt DateTime @default(now())`, `@@id([eventTypeId, userId])`, `@@index([userId])`, cascade on delete from `EventType` and `User`); model `EventTypeNotetakerSharingChange` (`id String @id @default(uuid())`, `eventTypeId Int`, `actorUserId Int?`, `actorName String?`, `previousMode`, `newMode`, `addedUserNames String[]`, `removedUserNames String[]`, `createdAt DateTime @default(now())`, `@@index([eventTypeId, createdAt])`, cascade on delete from `EventType`); back-relations on `EventType` and `User`. Then run `yarn prisma generate` (A1/B1)
- [X] T006 Write the migration by hand as `packages/prisma/migrations/<timestamp>_add_notetaker_event_type_sharing_and_speaker_names/migration.sql` matching T005 exactly (additive only, no backfill); apply it to the scratch database only and confirm `prisma migrate diff` between the scratch database and the schema is empty (A1/B1)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: contract and DTO shapes every story reads.

- [X] T007 [P] Add the optional fields `speakerNamesAvailable: boolean` and `speakerResolutions` (array of at most 64 `{ speakerKey: string min 1, resolvedSpeakerKey: string min 1, speakerName: string 1..200 }`) to the `session.ended` data schema in `packages/lib/notetaker/botContract.ts`, with tests in `packages/lib/notetaker/botContract.test.ts` for presence, absence and the limits (A1)
- [X] T008 [P] Update DTOs in `packages/lib/dto/`: `NotetakerStateDto.ts` (`viewerRole` gains `"SHARED_VIEWER"`; optional `access` object as in contracts/trpc-notetaker-sharing.md; `transcript.speakerNamesAvailable: boolean | null`), `NotetakerActivityDto.ts` (actions `"SHARED_VIEWED"`, `"SHARING_MODE_CHANGED"`, `"SHARING_PEOPLE_CHANGED"`), `NotetakerTranscriptDto.ts` if the flag lives there, `NotetakerDisclosureDto` (`sharedWithColleagues: boolean`), new `NotetakerEventTypeSharingDto.ts` and `NotetakerSharedResultDto.ts` with Zod schemas and string-literal unions (no Prisma enums); extend `packages/lib/dto/NotetakerDto.test.ts` (A1/B1)
- [X] T009 Extend the repository interfaces in `packages/features/notetaker/repositories/interfaces/`: booking context gains `teamId`, `teamName`, `organizationId` (the team's `parentId`), `sharingMode`; session reads gain `colleagueSharingDisclosed`; transcript repository gains "set `speakerNamesAvailable`" and "replace speaker fields for all passages of a transcript with a given `speakerKey`"; settings repository gains mode read and write, selected-people list read and replace, "is user on the list", change-history insert and list since a date; booking repository gains the paginated "shared with user" query (B1)
- [X] T010 Implement T009 in `packages/features/notetaker/repositories/PrismaBookingNotetakerRepository.ts`, `PrismaEventTypeNotetakerSettingsRepository.ts` and `PrismaNotetakerTranscriptRepository.ts` (and the session repository file that owns session reads), with `select` only; the shared list starts from the given team ids and event type ids, never from all bookings (B1)
- [X] T011 Mirror T009 in `packages/features/notetaker/tests/InMemoryNotetakerRepositories.ts` so unit tests of later tasks can use it (B1)

**Checkpoint**: `yarn type-check:ci --force` passes; existing notetaker tests still pass.

---

## Phase 3: User Story 1 - Transcript passages carry the names of the people who spoke (Priority: P1) MVP

**Goal**: each passage shows the participant's meeting name, consistently, never a guessed name.

**Independent Test**: quickstart Scenario 2 (three people speak in turn; every passage has the right name) and Scenario 3 (names unavailable is stated).

### Application side (does not depend on the measurement)

- [X] T012 [P] [US1] Tests first in `packages/features/notetaker/services/NotetakerSessionEventService.test.ts`: on `session.ended` with resolutions, every passage with the old key gets the new key and name and a null unknown number; an entry whose `speakerKey` does not start with `unknown:` or whose `resolvedSpeakerKey` does not start with `participant:` is dropped and the event still succeeds; `speakerNamesAvailable` is stored, null when absent; reprocessing the same event changes nothing (A1)
- [X] T013 [US1] Implement T012 in `packages/features/notetaker/services/NotetakerSessionEventService.ts` so resolutions are applied before finalize and summary start (A1)
- [X] T014 [P] [US1] Create `packages/features/notetaker/lib/speakerLabel.ts` (one function returning the display label for a passage: the name, or the translated "Unknown speaker N") with a test, and use it in `packages/features/notetaker/lib/exportMarkdown.ts`, `packages/features/notetaker/summary/AnthropicSummaryGenerator.ts` and `packages/features/notetaker/summary/StubSummaryGenerator.ts`; the summary prompt also receives one roster line per distinct speaker key listing every name that key used; update their tests (A4)
- [X] T015 [P] [US1] Expose `speakerNamesAvailable` through `packages/features/notetaker/services/NotetakerResultsService.ts` and `NotetakerChoiceService.ts` state, show one sentence when it is false in `apps/web/modules/notetaker/components/NotetakerTranscript.tsx` and in `exportMarkdown.ts`, add the i18n key to `packages/i18n/locales/en/common.json`, add scripts with resolutions and with `speakerNamesAvailable: false` to `packages/features/notetaker/bot/FakeBotGateway.ts`; update the component and service tests (A4)

### Bot side (signal order per T004)

- [ ] T016 [US1] Add to `apps/notetaker-bot/src/platform/browser/MeetingPage.ts` one method `readElements(selector, attributeNames, innerTextSelector)` returning for each match the named attribute values (null when absent) and the text of the first inner match (null when none), main frame only, never HTML; state the contract in the file's comment block (A2)
- [ ] T017 [P] [US1] Implement `readElements` in `apps/notetaker-bot/src/platform/browser/PlaywrightChromeLauncher.ts` with one `evaluateAll` call per read (A2)
- [ ] T018 [P] [US1] Implement `readElements` in `apps/notetaker-bot/src/platform/browser/FakeMeetingPage.ts` with a `setElements(selector, rows)` test control and tests in `apps/notetaker-bot/src/platform/browser/FakeMeetingPage.test.ts`; forward and record it (selector key and row count only, no values) in `apps/notetaker-bot/scripts/meetProbeRecorder.ts` and `meetProbeTypes.ts` with a test (A2)
- [ ] T019 [US1] Tests first in `apps/notetaker-bot/src/platform/GoogleMeetAdapter.test.ts`, then implement in `apps/notetaker-bot/src/platform/GoogleMeetAdapter.ts`: `readParticipants(page)` reads every top-level `[data-participant-id]` tile and returns `{ participantId, name, sourceKeys, isSelf }` (`sourceKeys` from `data-ssrc` as `ssrc:<n>` and `csrc:<n>`; `isSelf` from the marker found in T004, otherwise from the tile that never has a source while the microphone is off); replace the `activeSpeakerName` selector with the indicator found in T004, or remove the UI signal for Meet if T004 excluded it (A2)
- [ ] T020 [US1] Tests first in `apps/notetaker-bot/src/platform/browser/BrowserPlatformAdapter.test.ts`, then implement in `BrowserPlatformAdapter.ts`: `readParticipants` is an optional driver method; when present, each poll emits `source_identity` for every new or changed link and keys `speaker` events by participant id instead of display name, carrying the current name; a driver without it behaves exactly as today (Teams tests unchanged) (A2)
- [ ] T021 [US1] Tests first in `apps/notetaker-bot/src/speakers/SpeakerAttributor.test.ts`, then implement in `SpeakerAttributor.ts` and `SpeakerAttribution.ts`: speaker key `participant:<SHA-256 of a per-session random salt plus the participant id, first 16 hex characters>`; per-voice tally with options `minVoiceVotes = 3` and `minVoiceAgreement = 0.9` used when the signals give no answer; two participant ids with one display name get the suffixes ` (2)`, ` (3)` in order of first appearance; a participant flagged self is never returned; `resolutions()` lists each `unknown:<n>` whose voice now meets the threshold with the participant key and name; `namesAvailable()` is true once any participant was identified; signal order is a constructor option set from T004 (A3)
- [ ] T022 [US1] Tests first in `apps/notetaker-bot/src/runner/MeetingRunner.test.ts`, then implement in `MeetingRunner.ts` and `createMeetingRunner.ts`: pass the self flag and names to the attributor, and send `speakerResolutions` and `speakerNamesAvailable` in `session.ended` on every end path including stop and interruption (A3)
- [ ] T023 [US1] Only if T004 found Q3 excluded: fix the source timestamp filter in `apps/notetaker-bot/src/audio/captureScript.ts` with a test in its test file; otherwise record in `docs/verification-status.md` that the filter was confirmed and close the task (A2)

**Checkpoint**: bot and notetaker unit tests pass; the fake bot shows named, resolved and names-unavailable transcripts in the application.

---

## Phase 4: User Story 2 - Share every result of a team event type with the whole team (Priority: P2)

**Goal**: with the whole-team mode, current team members read results of meetings held under it.

**Independent Test**: quickstart Scenario 4.

- [X] T024 [P] [US2] Create the port `packages/features/notetaker/lib/membershipLookup.ts` (`isAcceptedMember({ userId, teamId }): Promise<boolean>` and `listAcceptedTeamIds({ userId }): Promise<number[]>`), a DI module `packages/features/notetaker/di/NotetakerMembershipLookup.module.ts` binding it to `MembershipRepository` by direct path, its token in `packages/features/notetaker/di/tokens.ts`, and an in-memory fake in `packages/features/notetaker/tests/` (B2)
- [X] T025 [US2] Tests first in `packages/features/notetaker/services/NotetakerAccessService.test.ts` covering every row of the access matrix in contracts/trpc-notetaker-sharing.md for the `TEAM` mode (accepted member with a disclosed session is `SHARED_VIEWER`; removed or unaccepted member refused; undisclosed session refused; `HOSTS_ONLY` refuses a team admin who is not a host; event type without a team refused; host and attendee results unchanged), replacing the existing case "rejects a team or organization admin with no relation to the booking"; the refusal keeps the existing message (B2)
- [X] T026 [US2] Implement T025 in `packages/features/notetaker/services/NotetakerAccessService.ts` (role `SHARED_VIEWER` checked after host and attendee; `assertHost` unchanged) and wire the port in `packages/features/notetaker/di/NotetakerAccessService.module.ts`; replace the class comment that forbids a membership dependency with one stating the single case in which membership grants read access (B2)
- [X] T027 [US2] Tests first, then implement in `packages/features/notetaker/services/NotetakerChoiceService.ts` and `NotetakerResultsService.ts`: `getState` for `SHARED_VIEWER` returns `choice: null`, `canToggle: false`, `canStop: false` and `featureEnabled` by the rule used for attendees; `listPassages` and `export` are allowed; every host-only operation refuses; the first `getState` per user and booking writes a `SHARED_VIEWED` activity and later calls write none (B2)
- [ ] T028 [US2] Tests first, then create `packages/features/notetaker/services/NotetakerSharingSettingsService.ts` with DI module and container in `packages/features/notetaker/di/`: `get(eventTypeId, userId)` returns `NotetakerEventTypeSharingDto` with `unavailableReason` `"FEATURE_DISABLED"` or `"NOT_A_TEAM_EVENT_TYPE"`; `set` stores the mode, refuses a mode other than `HOSTS_ONLY` on an event type without a team (bad request), writes `sharingSetByUserId` and `sharingSetAt`, and writes one `EventTypeNotetakerSharingChange` only when something changed (B3)
- [ ] T029 [US2] Tests first in `packages/features/notetaker/services/NotetakerDispatchService.test.ts`, then implement in `NotetakerDispatchService.ts`: when the event type's mode is not `HOSTS_ONLY`, the join request's `noticeMessage` uses the new key `notetaker_meeting_notice_shared` and the created session has `colleagueSharingDisclosed = true`; otherwise both stay as today; add the key to `packages/i18n/locales/en/common.json` (B3)
- [ ] T030 [P] [US2] Add `getEventTypeSharing` and `setEventTypeSharing` (`{ eventTypeId, mode, userIds? }`, `userIds` 0 to 50 distinct) as `.schema.ts` and `.handler.ts` files in `packages/trpc/server/routers/viewer/notetaker/`, register them on `eventOwnerProcedure` in `_router.tsx`, with handler tests and a router test update in `_router.test.ts` (B3)
- [ ] T031 [US2] Tests first, then create `packages/features/notetaker/services/NotetakerSharedResultsService.ts` with DI module and container: lists results the user can read as `SHARED_VIEWER` (disclosed session, transcript present, mode and membership as in the access matrix), excludes bookings where the user is host or attendee, newest meeting first, cursor pagination, `limit` 1 to 50 default 20, returns `NotetakerSharedResultDto` rows (B4)
- [ ] T032 [P] [US2] Add `listSharedWithMe` (`{ cursor?, limit? }`) as schema and handler in `packages/trpc/server/routers/viewer/notetaker/` on `authedProcedure`, registered in `_router.tsx`, with a handler test (B4)
- [ ] T033 [P] [US2] Create `apps/web/modules/notetaker/components/NotetakerSharedResultsList.tsx` with its hook in `apps/web/modules/notetaker/hooks/` and the page `apps/web/app/(use-page-wrapper)/(main-nav)/bookings/shared-notes/page.tsx` (session check in `page.tsx`, redirect to login when absent); each row links to `/booking/<uid>/notetaker`; add a link to the page from the bookings view header in `apps/web/modules/bookings/views/bookings-view.tsx`; empty state and strings in `common.json`; component test (B4)
- [ ] T034 [US2] Create `apps/web/modules/notetaker/components/NotetakerEventTypeSharing.tsx` (three-option control: hosts only, whole team, selected people; a sentence saying sharing applies to meetings held from now on; hidden when `available` is false) with mutation hooks in `apps/web/modules/notetaker/hooks/useNotetakerMutations.ts`, mount it under the existing notetaker default through `apps/web/modules/event-types/components/tabs/advanced/EventAdvancedWebWrapper.tsx` and the prop in `EventAdvancedTab.tsx`; strings in `common.json`; component test. The people picker is added in T039 (B5)
- [ ] T035 [US2] Render the new role read-only: in `apps/web/modules/notetaker/components/NotetakerResultsPage.tsx`, `NotetakerResultsActions.tsx` and `NotetakerBookingSection.tsx` a `SHARED_VIEWER` sees status, transcript, summary and export and no share, delete, stop, toggle or activity control; update their tests (B5)

**Checkpoint**: Scenario 4 passes against the scratch setup with the fake bot.

---

## Phase 5: User Story 3 - Share every result of an event type with selected people (Priority: P2)

**Goal**: named people from the organization read results; other team members do not.

**Independent Test**: quickstart Scenario 5.

- [X] T036 [US3] Tests first in `packages/features/notetaker/services/NotetakerAccessService.test.ts`, then extend `NotetakerAccessService.ts` for `SELECTED_PEOPLE`: a listed user who is an accepted member of the team's organization (or of the team when `organizationId` is null) with a disclosed session is `SHARED_VIEWER`; a listed user who left is refused; an unlisted team member is refused; a listed user under mode `TEAM` gains nothing from the list (B2)
- [ ] T037 [US3] Tests first, then extend `NotetakerSharingSettingsService.ts`: `set` with `userIds` replaces the list, refuses more than 50, refuses any user who is not an accepted member of the organization or team (bad request that names no user), keeps the list when `userIds` is omitted and when the mode is `TEAM` or `HOSTS_ONLY`, and records added and removed names in the change row; `get` returns `people` with `stillEligible`; new `listCandidates({ eventTypeId, search, cursor, limit })` returns accepted members of the organization or team, `limit` 1 to 50 default 20 (B3)
- [ ] T038 [P] [US3] Add `listEventTypeSharingCandidates` schema and handler in `packages/trpc/server/routers/viewer/notetaker/` on `eventOwnerProcedure`, registered in `_router.tsx`, with a handler test; extend `NotetakerSharedResultsService.ts` and its test so results reachable through the selected list appear in "Shared with me" with `route: "SELECTED_PEOPLE"` (B3/B4)
- [ ] T039 [US3] Add the people picker to `apps/web/modules/notetaker/components/NotetakerEventTypeSharing.tsx` (search through `listEventTypeSharingCandidates`, chips with name and avatar, a marker and remove action for a person with `stillEligible: false`, limit message at 50), shown only for the selected-people mode and kept in state when another mode is chosen; strings in `common.json`; component test (B5)

**Checkpoint**: Scenario 5 passes against the scratch setup.

---

## Phase 6: User Story 4 - Everyone can see who has access (Priority: P3)

**Goal**: hosts see who can read a result and a history; bookers and participants are told.

**Independent Test**: quickstart Scenario 6.

- [ ] T040 [US4] Tests first, then implement in `packages/features/notetaker/services/NotetakerChoiceService.ts`: for a host, `getState` returns `access` (`attendees`, and `colleagues` as null, `{ route: "TEAM", teamName }` or `{ route: "SELECTED_PEOPLE", people }` with at most 50 names of people who are still eligible); null when the session is not disclosed or the mode is `HOSTS_ONLY`; absent for other roles (B5)
- [ ] T041 [P] [US4] Create `apps/web/modules/notetaker/components/NotetakerAccessSummary.tsx` (plain statement of who has access and by which route) and show it to hosts in `NotetakerResultsPage.tsx`; strings in `common.json`; component test (B5)
- [ ] T042 [US4] Tests first, then implement in `packages/features/notetaker/services/NotetakerResultsService.ts`: `getActivity` merges the event type's `EventTypeNotetakerSharingChange` rows created at or after the booking's first session into the list as `SHARING_MODE_CHANGED` (mode differs) or `SHARING_PEOPLE_CHANGED` (same mode) with `detail { previousMode, newMode, addedUserNames, removedUserNames }`, ordered by time with the existing entries; render the three new actions in `apps/web/modules/notetaker/components/NotetakerActivityList.tsx` with labels in `common.json` and a component test (B5)
- [ ] T043 [US4] Tests first, then implement: `getDisclosure` in `NotetakerChoiceService.ts` and `packages/trpc/server/routers/publicViewer/notetakerDisclosure.handler.ts` return `sharedWithColleagues` (true when the event type's mode is not `HOSTS_ONLY`); `apps/web/modules/notetaker/components/NotetakerDisclosure.tsx` shows the key `notetaker_disclosure_shared` when it is true; add the key to `common.json`; update the handler and component tests (B3/B5)

**Checkpoint**: Scenario 6 passes against the scratch setup.

---

## Phase 7: Polish and Cross-Cutting

- [ ] T044 [P] Integration tests against the scratch database only: the new settings repository methods in a new `packages/features/notetaker/repositories/PrismaEventTypeNotetakerSettingsRepository.integration-test.ts`, the shared-list query and booking context in `PrismaBookingNotetakerRepository.integration-test.ts`, and the passage resolution update in the transcript repository's integration test (B6)
- [ ] T045 Add one scenario to `apps/web/playwright/notetaker.e2e.ts`: team event type, admin sets whole-team sharing, a transcribed meeting through the fake bot, a second member opens it from "Shared with me" and has no delete or share control, an outsider is refused with the existing message, the admin switches to hosts only and the member is refused; run the file against the scratch setup (B6)
- [ ] T046 Run `yarn type-check:ci --force`, the unit suites listed in quickstart.md with `TZ=UTC`, and `yarn biome check` on the changed paths; fix what they report and record the counts in the last PR description (B6)
- [ ] T047 [P] Update `apps/notetaker-bot/docs/verification-status.md` (rows for the attributor, the Meet adapter and the launcher; what is verified against the real page and what only against the fake) and `specs/001-meeting-transcription/tasks.md` task T175 (mark done with a pointer to the measurement run, or state what remains) (A5)
- [ ] T048 Deploy with the owner's agreement on the time: apply the one migration to the live database, rebuild in place with `/root/caldiy-deploy-inplace.sh`, build and install the bot bundle into `/opt/notetaker-bot/dist/` keeping the previous one in `/opt/notetaker-bot/rollback/`, restart `notetaker-bot` when no meeting is running, and run the existing smoke checks (A5/B7)
- [ ] T049 Acceptance on the live site: quickstart Scenario 2 with three speakers (count correct, wrong and unknown passages for SC-001 and SC-002 and record them in `apps/notetaker-bot/docs/verification-status.md`), then Scenario 4 steps 1 to 4 and Scenario 6 steps 1 to 3 (A5/B7)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup**: T001 → T002 → T003 → T004 (measurement; needs people). T005 → T006 are independent of T001 to T004.
- **Foundational**: T007 and T008 need T005. T009 → T010 and T011 need T005 and T008.
- **US1**: application tasks T012 to T015 need Phase 2 only. Bot tasks T016 to T023 need T004. T021 needs T020; T022 needs T021 and T007.
- **US2**: needs Phase 2. T024 → T025 → T026 → T027. T028 → T030. T029 needs T010. T031 needs T026 → T032 → T033. T034 needs T030. T035 needs T027.
- **US3**: needs US2 (T026, T028, T031, T034).
- **US4**: needs US2 (T026, T028, T029); T040 also reads the list from US3 and returns only the team route until T037 is merged.
- **Polish**: T044 to T046 need the stories they cover; T048 needs everything to be deployed in that round; T049 needs T048.

### Story independence

- **US1** is independent of US2 to US4 and can ship alone.
- **US2** can ship without US3 and US4 (the settings control then offers two modes).
- **US3** and **US4** each add to US2.

### Delivery groups (one PR each)

| Group | Tasks |
|-------|-------|
| A0 | T001, T002, T003 |
| A0-run | T004 (docs only) |
| A1/B1 | T005, T006, T007, T008, T009, T010, T011, T012, T013 |
| A2 | T016, T017, T018, T019, T020, T023 |
| A3 | T021, T022 |
| A4 | T014, T015 |
| B2 | T024, T025, T026, T027, T036 |
| B3 | T028, T029, T030, T037, T038 (candidates), T043 (server part) |
| B4 | T031, T032, T033, T038 (shared list part) |
| B5 | T034, T035, T039, T040, T041, T042, T043 (web part) |
| B6 | T044, T045, T046 |
| A5/B7 | T047, T048, T049 |

### Parallel opportunities

- T001 to T003 (bot probe) run alongside T005 to T011 (schema and shapes).
- After Phase 2: US1 application tasks (T012 to T015) run alongside US2 server tasks (T024 to T029); they touch different services except `NotetakerChoiceService.ts` and `NotetakerResultsService.ts`, which T015, T027, T040 and T042 change one after another.
- Within US1 bot: T017 and T018 in parallel after T016.
- Within US2: T030, T032 and T033 in parallel once their services exist.

### Parallel example: after Phase 2

```text
Agent 1: T012 → T013 (session event service)
Agent 2: T014 (speaker label, export, summary prompt)
Agent 3: T024 → T025 → T026 (access)
Agent 4: T028 → T030 (settings service and procedures)
Agent 5: T029 (dispatch notice and flag)
```

## Implementation Strategy

- **MVP**: Phase 1, Phase 2 and User Story 1. It fixes the defect users see today.
- **Start both tracks at once**: the measurement (T004) needs a meeting with two people, so the schema, shapes and all of Part B proceed while it is being arranged.
- **Deploy once per part** if possible: Part A needs a bot bundle and an application rebuild; Part B needs the migration and a rebuild. Combining them means one downtime of about 6 minutes.
- **Stop rule**: if the measurement excludes both signals, Part A delivers T012 to T015 (consistent labels, resolutions plumbing, names-unavailable statement) and the owner decides about captions before any further bot work.
