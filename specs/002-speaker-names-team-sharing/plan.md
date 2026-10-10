# Implementation Plan: Notetaker Speaker Names and Team Sharing

**Branch**: `002-speaker-names-team-sharing` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-speaker-names-team-sharing/spec.md`

## Summary

Two independent parts built on the notetaker of `specs/001-meeting-transcription`.

**Part A, speaker names.** Transcripts show only numbered speakers because neither signal the bot uses to name a speaker works on the real Google Meet page: the audio-source signal has no link from a source to a participant (no code emits it), and the page indicator relies on a guessed label that never appears. The fix starts with a measurement in a meeting with speech, then links each participant tile to its audio source, identifies participants by the page's participant id instead of their name, remembers which voice belongs to which participant, and sends a final list of resolved voices so earlier passages get their names. Transcripts say so when names were unavailable.

**Part B, sharing by event type.** A team admin sets one sharing mode per team event type: hosts only (default), whole team, or selected people from the organization. Access for colleagues is read-only, decided on every request from current membership, and limited to meetings whose participants were told that colleagues may read the notes. A "Shared with me" page lets colleagues find results; hosts see who has access and a history of changes.

Details and alternatives are in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js 22 for the bot

**Primary Dependencies**: Next.js 16 (App Router), tRPC 11, Prisma 6.16, Zod 3, ioctopus DI (`moduleLoader`), Playwright 1.57 (bot, real Chrome), Soniox realtime speech service; no new dependency

**Storage**: PostgreSQL through Prisma; one additive migration (1 enum, 3 columns, 2 tables, 1 enum value)

**Testing**: Vitest (unit, and integration against the scratch database only), Playwright E2E for one scenario, a manual measurement run and one live meeting for the bot

**Target Platform**: the web application (`apps/web`) and the bot service (`apps/notetaker-bot`, Linux, Chrome under Xvfb)

**Project Type**: monorepo web application plus a bot service

**Performance Goals**: an access decision adds at most two indexed lookups (membership, selected person); the "Shared with me" page loads its first 20 rows in under 1 second for a user in 50 teams; the tile read adds no more than one page call per poll (every 500 ms)

**Constraints**: additive only (old bot with new application and the reverse must work); the checkout and its database are live, so no build, migration or database-writing test against them without the owner's go-ahead; the bot may not act in the meeting beyond joining, posting the notice and leaving; nothing identifying a participant leaves the bot except the display name

**Scale/Scope**: meetings of up to 8 speaking participants; up to 50 selected people per event type; teams of up to a few hundred members

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-design gates

| Gate | Status | Note |
|------|--------|------|
| I. Vertical slice, acyclic dependency graph | PASS | All logic stays in `packages/features/notetaker`; DTOs and the wire contract in `packages/lib`; procedures in `packages/trpc`; hooks and UI in `apps/web/modules/notetaker` |
| I. Features must not import trpc or web | PASS | Services throw `ErrorWithCode` |
| I. Cross-feature calls through public API; no barrel imports | PASS | Membership is read through a narrow lookup port owned by the notetaker slice and bound in DI to `MembershipRepository` by direct path |
| I. API v2 through platform-libraries | PASS | No API v2 change |
| II. Repositories, DTOs, `select`, DI moduleLoader | PASS | New data access only in notetaker repositories; two new DTOs; modules and containers per new dependency |
| III. Type safety, tests at or above 80%, `ErrorWithCode` | PASS | See the testing approach in [research.md](./research.md) |
| IV. Stable public APIs | PASS | Nothing public changes; tRPC outputs and the bot contract only gain optional fields |
| V. Performance and simplicity | PASS | Access checks are indexed lookups; the shared list starts from the viewer's memberships; the voice memory is a map per session |
| Security (`credential.key`, secrets, permission checks in `page.tsx`) | PASS | No credential access; the new page checks the session in `page.tsx`; settings use `eventOwnerProcedure`, not the stubbed permission service |
| Async work through the Trigger.dev Tasker pattern | PASS | No new task; finalize keeps its existing task |
| Localization | PASS | New strings in `packages/i18n/locales/en/common.json`, including the second notice and disclosure wording |
| Feature flag seeded by migration | PASS | No new flag; the existing `notetaker` flag gates everything and the default mode changes nothing |
| PR size | PASS | One PR per group in the delivery sequence; the owner waived the 500-line split for this auto-merged flow on 2026-10-09 |
| New dependencies | PASS | None |
| `schema.prisma` change | PASS (approval needed) | See approvals |
| Multi-package change | PASS (approval needed) | prisma, lib, features, trpc, i18n, apps/web, apps/notetaker-bot |
| Running E2E or a full build | PASS (approval needed) | One added scenario in the notetaker E2E file; an in-place rebuild at deployment |
| Deleting files | PASS | None |

### Approvals required before implementation

Constitution requirements. Work on the affected groups does not start until each is granted.

1. `schema.prisma` change: enum `NotetakerSharingMode`, value `SHARED_VIEWED` on `NotetakerActivityAction`, three columns, models `EventTypeNotetakerSharingMember` and `EventTypeNotetakerSharingChange`, back-relations on `EventType` and `User`.
2. Multi-package change (prisma, lib, features, trpc, i18n, apps/web, apps/notetaker-bot).
3. Running the notetaker E2E file against the scratch setup.
4. Removing the rule "team and organization admins never gain access through a role" from `NotetakerAccessService` in the one case this feature defines (a colleague under a sharing mode), and rewriting the test that asserts it.
5. Deployment: applying the migration to the live database and an in-place rebuild of the live site (about 6 minutes of downtime), plus a bot restart.
6. Two real meetings with the diagnostic or the notetaker present (the measurement run and the acceptance run), with the participants told beforehand.

### Post-design re-check

All gates still pass after Phase 1. The design adds no dependency, no public endpoint and no new async task. The one behavioural widening (approval 4) is the purpose of the feature and is bounded by the access matrix in [contracts/trpc-notetaker-sharing.md](./contracts/trpc-notetaker-sharing.md). No violation needs justification.

## Project Structure

### Documentation (this feature)

```text
specs/002-speaker-names-team-sharing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── bot-contract-speakers.md
│   └── trpc-notetaker-sharing.md
├── checklists/requirements.md
└── tasks.md                     # created by /speckit-tasks
```

### Source Code (repository root)

```text
apps/notetaker-bot/
├── scripts/
│   ├── meetProbePageScript.ts        # record hashed tile ids and sources, receiver sources (A1)
│   ├── meetProbeReport.ts            # verdicts for the three measurement questions
│   └── meetProbeTypes.ts
├── src/
│   ├── platform/
│   │   ├── browser/MeetingPage.ts            # one structured read of attributes and inner text
│   │   ├── browser/PlaywrightChromeLauncher.ts
│   │   ├── browser/FakeMeetingPage.ts
│   │   ├── browser/BrowserPlatformAdapter.ts # optional readParticipants; emits source_identity; keys by participant id
│   │   └── GoogleMeetAdapter.ts              # tile read: participant id, source, name, self
│   ├── speakers/
│   │   ├── SpeakerAttributor.ts              # voice memory, resolutions, duplicate-name suffix, self exclusion
│   │   └── SpeakerAttribution.ts
│   ├── runner/MeetingRunner.ts               # sends resolutions and the names flag in session.ended
│   └── audio/captureScript.ts                # only if the measurement shows the timestamp filter is wrong
└── docs/verification-status.md, docs/speaker-attribution-spike.md

packages/prisma/
├── schema.prisma
└── migrations/<timestamp>_add_notetaker_event_type_sharing_and_speaker_names/migration.sql

packages/lib/
├── notetaker/botContract.ts                  # optional fields on session.ended
└── dto/
    ├── NotetakerStateDto.ts, NotetakerActivityDto.ts, NotetakerTranscriptDto.ts
    ├── NotetakerEventTypeSharingDto.ts       # new
    └── NotetakerSharedResultDto.ts           # new

packages/features/notetaker/
├── lib/
│   ├── membershipLookup.ts                   # new port: accepted member of a team or organization
│   └── speakerLabel.ts                       # new: one wording for unknown speakers
├── repositories/
│   ├── interfaces/*.ts
│   ├── PrismaEventTypeNotetakerSettingsRepository.ts   # mode, list, change history
│   ├── PrismaBookingNotetakerRepository.ts             # booking context gains team, organization, mode, disclosed flag; shared list query
│   └── PrismaNotetakerTranscriptRepository.ts          # apply a speaker resolution; names flag
├── services/
│   ├── NotetakerAccessService.ts             # SHARED_VIEWER
│   ├── NotetakerSharingSettingsService.ts    # new: get, set, candidates, change history
│   ├── NotetakerSharedResultsService.ts      # new: "shared with me"
│   ├── NotetakerChoiceService.ts             # state for the new role, access summary, disclosure flag
│   ├── NotetakerResultsService.ts            # first-view activity, merged history
│   ├── NotetakerDispatchService.ts           # wider notice and the disclosed flag
│   ├── NotetakerSessionEventService.ts       # apply resolutions and the names flag
│   └── (summary/) AnthropicSummaryGenerator.ts, StubSummaryGenerator.ts, lib/exportMarkdown.ts
├── di/                                       # modules, containers and tokens for the new pieces
├── bot/FakeBotGateway.ts                     # scripts with resolutions and the names flag
└── tests/InMemoryNotetakerRepositories.ts

packages/trpc/server/routers/viewer/notetaker/
├── _router.tsx
├── getEventTypeSharing.{schema,handler}.ts
├── setEventTypeSharing.{schema,handler}.ts
├── listEventTypeSharingCandidates.{schema,handler}.ts
└── listSharedWithMe.{schema,handler}.ts
packages/trpc/server/routers/publicViewer/notetakerDisclosure.handler.ts

apps/web/
├── app/(use-page-wrapper)/(main-nav)/bookings/shared-notes/page.tsx     # new
├── modules/notetaker/components/
│   ├── NotetakerEventTypeSharing.tsx         # new: mode control and people picker
│   ├── NotetakerAccessSummary.tsx            # new
│   ├── NotetakerSharedResultsList.tsx        # new
│   ├── NotetakerResultsPage.tsx, NotetakerResultsActions.tsx, NotetakerBookingSection.tsx
│   ├── NotetakerTranscript.tsx, NotetakerActivityList.tsx, NotetakerDisclosure.tsx
├── modules/notetaker/hooks/
├── modules/event-types/components/tabs/advanced/EventAdvancedWebWrapper.tsx, EventAdvancedTab.tsx
└── playwright/notetaker.e2e.ts

packages/i18n/locales/en/common.json
```

**Structure Decision**: No new package or slice. Everything extends the existing notetaker slice, its tRPC router, its web module and the bot workspace, in the same layout the first specification established.

### Delivery sequence

Part A and Part B do not depend on each other. Within each part the groups merge in order; one PR per group.

**Part A: speaker names**

| Group | Content | Depends on |
|-------|---------|------------|
| A0 | Probe extension (hashed tile and receiver sources, three verdicts) and its tests | none |
| A0-run | Measurement run in a meeting with speech; verdicts recorded in `docs/speaker-attribution-spike.md`. Decides the signal order for A2 | A0, approval 6 |
| A1 | Wire contract and data: optional fields on `session.ended`, `speakerNamesAvailable` column (in the shared migration), repository method to apply a resolution, event service applies resolutions, DTO field | approval 1 |
| A2 | Bot: structured tile read on `MeetingPage` and its three implementations; `readParticipants` in the Meet driver; `source_identity` and participant-id keys in `BrowserPlatformAdapter` | A0-run |
| A3 | Bot: voice memory, resolutions, duplicate-name suffix, self exclusion, names flag; runner sends them | A1, A2 |
| A4 | Application presentation: shared unknown-speaker wording, roster in the summary prompt, names-unavailable sentence on the results page and in the export, fake bot scripts | A1 |
| A5 | Deploy the bot and the application; acceptance meeting (quickstart Scenario 2); record results | A3, A4, approvals 5 and 6 |

**Part B: sharing**

| Group | Content | Depends on |
|-------|---------|------------|
| B1 | Schema and migration (shared with A1), DTOs, repository interfaces and Prisma implementations, in-memory repositories | approval 1 |
| B2 | Access: membership lookup port and DI, `SHARED_VIEWER` in `NotetakerAccessService`, state and results services for the new role, first-view activity | B1, approval 4 |
| B3 | Settings: `NotetakerSharingSettingsService`, change history, three event-type procedures, wider notice and disclosed flag at dispatch, disclosure flag for the booker | B1 |
| B4 | Shared list: `NotetakerSharedResultsService`, `listSharedWithMe`, the new page | B2 |
| B5 | Web UI: settings control with picker in the event type editor, access summary and merged history on the results page, read-only rendering for the new role, booking form wording, translations | B2, B3 |
| B6 | E2E scenario and integration tests on the scratch setup | B4, B5, approval 3 |
| B7 | Deploy (with A5 when both are ready) and run quickstart Scenarios 4 to 6 on the live site | B6, approval 5 |

The migration is written once and merged with whichever of A1 and B1 comes first.

## Complexity Tracking

No constitution violation needs justification.

## Open items

- **The signal order for names depends on the measurement run (A0-run).** If neither the tile source nor a page indicator follows speech, Part A delivers the plumbing, consistent numbered speakers and the names-unavailable statement, and SC-001 cannot be met on Google Meet without allowing captions, which would need a change to FR-016 of the first specification.
- **A booking made before sharing was turned on and held after it** is covered; its booker read the narrower wording at booking time and the wider one in the meeting (research B2).
- **Microsoft Teams** keeps its unverified indicator and reports names as unavailable when it identifies nobody.
- **Managed event types** are out of scope.
- **A link to the results on the public booking page** (`/booking/<uid>`) was raised on 2026-10-10 and is not part of this specification.
