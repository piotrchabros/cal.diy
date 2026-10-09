# Implementation Plan: Meeting Transcription Notetaker

**Branch**: `001-meeting-transcription` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-meeting-transcription/spec.md`

## Summary

A host can turn a notetaker on for a booking held on Google Meet, and later on Microsoft Teams. The notetaker joins the meeting visibly under a name that identifies it, transcribes the conversation with speaker attribution, and then publishes the transcript and a summary on the booking. On Google Meet the notetaker joins signed in to one dedicated Google account, so the name participants see is that account's; the app adds the account to the booking's Google Calendar event shortly before the meeting so that Meet lets it in without a person. The host can stop it at any time, share the results with attendees, export them and delete them. Hosts can also set a default per event type, and the booking page tells guests about it before they confirm.

The app owns the choices, scheduling, storage, summaries and notifications. It is built as a feature slice in `packages/features/notetaker`, with Trigger.dev tasks for the scheduled sweep, finalization, summary generation and notifications. A separate bot service, `apps/notetaker-bot`, joins the meeting in a real browser and streams text back to the app over a signed HTTP contract. The app never depends on how the bot works, only on `INotetakerBotGateway`. A fake bot gateway emits scripted events, so the whole app side can be built and tested before the real bot exists. Design rationale and alternatives are in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.9.3 (strict); Node 20 (Dockerfile `node:20`; `engines` does not pin Node)

**Primary Dependencies**: Existing: Next.js 16.2.3 (App Router), React 18.2, tRPC 11.0.0-next-beta.222, Prisma 6.16.1, Zod 3.25.76, `@trigger.dev/sdk` 4.3.2, `@evyweb/ioctopus` 1.2.0, `@calcom/emails`. New, each needing approval: `@anthropic-ai/sdk` in `packages/features`; in `apps/notetaker-bot`, `playwright`, `ws` and a container-launcher client (to be chosen once the hosting question is answered). The summary model is default `claude-opus-5-5`, configurable via `NOTETAKER_SUMMARY_MODEL`.

**Storage**: PostgreSQL via Prisma; 8 new models and 9 new enums, described in [data-model.md](./data-model.md). No object storage and no audio or video persisted.

**Testing**: Vitest 4.1.8 for unit tests and `*.integration-test.ts` files; Playwright 1.57.0 for E2E; all runs with `TZ=UTC`.

**Target Platform**: Web app on Vercel/Node; Trigger.dev tasks from `packages/features`; the bot as a Linux container (Chrome and Xvfb), one meeting per container.

**Project Type**: Web application in a Yarn 4.12 / Turbo monorepo, plus one new worker service.

**Performance Goals**: SC-001 enable in under 30 s; SC-002 join requested within 1 min of start in at least 95% of cases; SC-004 transcript and summary within 10 min of meeting end for meetings up to 60 min (95%); SC-007 notice within 30 s of admission; SC-008 failure reason visible within 15 min of scheduled end; SC-009 stop within 10 s.

**Constraints**: No audio or video retained (FR-030); hosts only by default (FR-026); additive-only public surface (FR-033); Cal Video untouched (FR-032); Trigger.dev task `maxDuration` of 600 s; PRs of at most 500 lines and 10 code files; all strings localized.

**Scale/Scope**: Meetings up to 4 h (about 3,000 passages, under 0.5 MB of text); SC-005 measured at up to 8 participants; one bot container per concurrent meeting; sweep work bounded per run (batches of 200, indexed on booking start); 32 app PRs and 6 bot PRs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-design gates

| Gate | Status | Note |
|------|--------|------|
| I. Vertical slice, acyclic dependency graph | PASS | Slice `packages/features/notetaker`; contract and DTOs in `packages/lib`; tRPC in `packages/trpc`; hooks and UI in `apps/web/modules/notetaker` |
| I. Features must not import trpc or web | PASS | Services throw `ErrorWithCode` |
| I. Cross-feature calls through public API; no barrel imports | PASS | The bookings slice imports only `NotetakerChoiceService` by direct path; the notetaker slice never imports `BookingEventHandlerService` |
| I. API v2 through platform-libraries | PASS | No API v2 change |
| II. Repositories, DTOs, `select`, DI moduleLoader | PASS | Six Prisma repositories behind interfaces; DTOs in `packages/lib/dto/`; a module and container per service |
| III. Type safety, tests at or above 80%, `ErrorWithCode` | PASS | Test strategy in [research.md](./research.md) (Decision 13, testing) and [quickstart.md](./quickstart.md) |
| IV. Stable public APIs | PASS | Nothing public is added or changed |
| V. Performance and simplicity | PASS | Indexed, batched sweep; paginated passages; no Day.js in loops; provider conditionals only in factories |
| Security (`credential.key`, secrets, permission checks in `page.tsx`) | PASS | No credential access; secrets by environment variable; session check in `page.tsx` |
| Async app work through the Trigger.dev Tasker pattern | PASS | Four tasks under `packages/features/notetaker/lib/tasker/` |
| Async bot runtime through Trigger.dev | VIOLATION (justified) | See Complexity Tracking |
| Localization | PASS | All strings in `packages/i18n/locales/en/common.json`, including the in-meeting notice and display name |
| Feature flag seeded by migration | PASS | Flag `notetaker` |
| PR size | PASS | Split in the delivery sequence below |
| New dependencies | PASS (approval needed) | `@anthropic-ai/sdk`; bot runtime dependencies |
| `schema.prisma` change | PASS (approval needed) | 8 models, 9 enums, back-relations on `Booking` and `EventType` |
| Multi-package change | PASS (approval needed) | prisma, lib, features, trpc, emails, i18n, apps/web and the new `apps/notetaker-bot` |
| Running E2E or a full build | PASS (approval needed) | One new E2E file with three specs |
| Deleting files | PASS | None |

### Approvals required before implementation

These are constitution requirements, not optional. Work on the affected PRs does not start until each is granted.

1. `schema.prisma` change: 8 models, 9 enums, and back-relations on `Booking` and `EventType`.
2. New dependency `@anthropic-ai/sdk` in `packages/features`.
3. New workspace `apps/notetaker-bot` with runtime dependencies `playwright`, `ws` and a launcher client.
4. Multi-package change (prisma, lib, features, trpc, emails, i18n, apps/web).
5. Running the E2E suite.
6. Edits to the shared booking code paths `RegularBookingService.fireBookingEvents`, `BookingEventHandlerService` and `editLocation.handler.ts`.

**Status (2026-10-09)**: all six were granted by Piotr Chabros at the start of the `/speckit-implement` run. Approval 5 was given for the new `apps/web/playwright/notetaker.e2e.ts` file, not for the wider E2E suite.

### Post-design re-check

- **I. Vertical slices, acyclic graph.** [data-model.md](./data-model.md) keeps every table inside the notetaker slice, with user references as soft integer columns so `User` gains no relation. [contracts/tasker.md](./contracts/tasker.md) places the tasks under `packages/features/notetaker/lib/tasker/`. [contracts/trpc-notetaker.md](./contracts/trpc-notetaker.md) keeps tRPC in `packages/trpc`, and the bot contract in [contracts/bot-control-api.md](./contracts/bot-control-api.md) and [contracts/bot-events-webhook.md](./contracts/bot-events-webhook.md) shares only `packages/lib/notetaker/botContract.ts` with the app. Satisfied.
- **II. Repositories and DTOs.** [data-model.md](./data-model.md) keeps all access behind repositories, and [contracts/trpc-notetaker.md](./contracts/trpc-notetaker.md) returns DTOs only. Satisfied.
- **III. Type safety and tests.** The state machine and outcome mapping in [data-model.md](./data-model.md) are fully tabulated, which makes them directly unit-testable. [quickstart.md](./quickstart.md) lists the automated checks and the fake-bot scenarios that exercise every outcome. Satisfied.
- **IV. Stable public APIs.** [contracts/public-api.md](./contracts/public-api.md) adds nothing public: no API v2 endpoint, no webhook trigger, no payload field and no change to the OpenAPI document. The two machine endpoints are internal. Satisfied.
- **V. Performance and simplicity.** [contracts/tasker.md](./contracts/tasker.md) describes one bounded, indexed sweep with no per-booking run bookkeeping. Passages are cursor-paginated in [contracts/trpc-notetaker.md](./contracts/trpc-notetaker.md). Satisfied.
- **Security and localization.** [contracts/notifications.md](./contracts/notifications.md) states that no message contains transcript text and lists the localized in-meeting strings. [contracts/bot-events-webhook.md](./contracts/bot-events-webhook.md) defines signature checking and the `410 Gone` kill switch. Satisfied.

A design addendum settled 23 open points found while writing the contracts, and [data-model.md](./data-model.md), the contracts, [quickstart.md](./quickstart.md) and [research.md](./research.md) reflect it; the constitution gates are unchanged by it, because it adds no models, dependencies, public surface or packages.

Phase 11 edits no shared booking or calendar file; it imports `createGoogleCalendarServiceWithGoogleType` and `CredentialRepository` read-only and adds one variable to `turbo.json` and `.env.example`.

**Result**: The gates pass, with three justified deviations recorded under Complexity Tracking. The six approvals listed above are outstanding and must be granted before the affected PRs begin.

## Project Structure

### Documentation (this feature)

```text
specs/001-meeting-transcription/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── checklists/
│   └── requirements.md  # Specification quality checklist
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── trpc-notetaker.md
│   ├── bot-control-api.md
│   ├── bot-events-webhook.md
│   ├── tasker.md
│   ├── notifications.md
│   └── public-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

Document guide:

- [research.md](./research.md): decisions with rationale and alternatives, departures from the tech-stack note, codebase findings, early risks, approval gates and open questions.
- [data-model.md](./data-model.md): eight models, nine enums, the session state machine, outcome mapping, retention and access rules.
- [quickstart.md](./quickstart.md): how to run the feature locally against the fake bot and validate each user story.
- [contracts/trpc-notetaker.md](./contracts/trpc-notetaker.md): the `viewer.notetaker` procedures, the public disclosure procedure, DTOs and errors.
- [contracts/bot-control-api.md](./contracts/bot-control-api.md): the signed app-to-bot HTTP API and the gateway interface.
- [contracts/bot-events-webhook.md](./contracts/bot-events-webhook.md): the signed bot-to-app event endpoint, event types, end reasons, ordering and idempotency.
- [contracts/tasker.md](./contracts/tasker.md): the four Trigger.dev tasks, the tasker interface and the synchronous fallback.
- [contracts/notifications.md](./contracts/notifications.md): the six email notices, their recipients and the in-meeting strings.
- [contracts/public-api.md](./contracts/public-api.md): what stays unchanged in the public API, plus the internal machine endpoints.

### Source Code (repository root)

```text
packages/prisma/schema.prisma                                   (changed)
packages/prisma/migrations/<ts>_add_notetaker_tables/migration.sql
packages/prisma/migrations/<ts>_seed_notetaker_feature/migration.sql
packages/features/flags/config.ts                               (changed: "notetaker")

packages/lib/notetaker/botContract.ts                           (Zod schemas, sign/verify)
packages/lib/dto/NotetakerStateDto.ts
packages/lib/dto/NotetakerTranscriptDto.ts                      (passage + transcript meta)
packages/lib/dto/NotetakerSummaryDto.ts
packages/lib/dto/NotetakerActivityDto.ts

packages/features/notetaker/
  lib/config.ts
  lib/eligibility.ts
  lib/sessionStateMachine.ts
  lib/exportMarkdown.ts
  repositories/
    PrismaBookingNotetakerRepository.ts          (choice + sharing grant)
    PrismaEventTypeNotetakerSettingsRepository.ts
    PrismaNotetakerSessionRepository.ts
    PrismaNotetakerTranscriptRepository.ts       (transcript + passages)
    PrismaNotetakerSummaryRepository.ts
    PrismaNotetakerActivityRepository.ts
    interfaces/I*.ts                             (one per repository)
  services/
    NotetakerAccessService.ts
    NotetakerChoiceService.ts
    NotetakerDispatchService.ts
    NotetakerSessionEventService.ts
    NotetakerFinalizeService.ts
    NotetakerSummaryService.ts
    NotetakerResultsService.ts
    NotetakerNotificationService.ts
    NotetakerCalendarInviteService.ts
  bot/
    INotetakerBotGateway.ts
    SelfHostedBotGateway.ts
    FakeBotGateway.ts
    NotetakerBotGatewayFactory.ts
  summary/
    INotetakerSummaryGenerator.ts
    AnthropicSummaryGenerator.ts
  calendar/
    INotetakerCalendarGuestGateway.ts
    GoogleCalendarGuestGateway.ts
    GoogleCalendarGuestGateway.test.ts
    googleEventsClient.ts                 the only file that imports shared calendar code
  lib/tasker/
    types.ts
    NotetakerTasker.ts
    NotetakerTriggerTasker.ts
    NotetakerSyncTasker.ts
    NotetakerTaskService.ts
    trigger/config.ts
    trigger/schema.ts
    trigger/dispatch-due-sessions.ts
    trigger/finalize-session.ts
    trigger/generate-summary.ts
    trigger/send-notification.ts
  di/tokens.ts
  di/<Class>.module.ts and <Service>.container.ts
  di/NotetakerCalendarGuestGateway.module.ts, NotetakerCalendarInviteService.module.ts   (no container)
  di/tasker/...
packages/features/di/tokens.ts                                  (changed: spread NOTETAKER_DI_TOKENS)
packages/features/trigger.config.ts                             (changed: add "./notetaker/lib/tasker/trigger")

packages/features/bookings/lib/onBookingEvents/BookingEventHandlerService.ts   (changed)
packages/features/bookings/di/BookingEventHandlerService.module.ts             (changed)
packages/features/bookings/lib/service/RegularBookingService.ts                (changed: recurring branch in fireBookingEvents)
packages/trpc/server/routers/viewer/bookings/editLocation.handler.ts           (changed)

packages/trpc/server/routers/viewer/notetaker/_router.tsx
packages/trpc/server/routers/viewer/notetaker/<procedure>.handler.ts and .schema.ts
packages/trpc/server/routers/viewer/_router.tsx                                (changed)
packages/trpc/server/routers/publicViewer/notetakerDisclosure.handler.ts and .schema.ts
packages/trpc/server/routers/publicViewer/_router.tsx                          (changed)

packages/emails/templates/{attendee-notetaker-notice,organizer-notetaker-admit-prompt,
  organizer-notetaker-results-ready,organizer-notetaker-failed,
  organizer-notetaker-turned-off,attendee-notetaker-shared}-email.ts
packages/emails/src/templates/Notetaker*.tsx and index.ts                      (changed)
packages/emails/notetaker-email-service.ts
packages/i18n/locales/en/common.json                                           (changed)

apps/web/app/api/notetaker/events/route.ts
apps/web/app/api/cron/notetaker/route.ts
apps/web/vercel.json                                                           (changed: cron entry)
apps/web/app/(use-page-wrapper)/(main-nav)/booking/[uid]/notetaker/page.tsx
apps/web/modules/notetaker/
  hooks/useNotetakerState.ts
  hooks/useNotetakerMutations.ts
  components/NotetakerBookingSection.tsx
  components/NotetakerStatusBadge.tsx
  components/NotetakerResultsPage.tsx
  components/NotetakerSummary.tsx
  components/NotetakerTranscript.tsx
  components/NotetakerActivityList.tsx
  components/NotetakerEventTypeDefault.tsx
  components/NotetakerDisclosure.tsx
apps/web/modules/bookings/components/BookingDetailsSheet.tsx                   (changed: mount section)
apps/web/modules/event-types/components/tabs/advanced/EventAdvancedTab.tsx     (changed: mount default toggle)
apps/web/modules/bookings/components/BookEventForm/...                         (changed: mount disclosure)
apps/web/playwright/notetaker.e2e.ts
turbo.json, .env.example                                                       (changed: env)

apps/notetaker-bot/
  package.json, tsconfig.json, Dockerfile
  src/server.ts                      (controller HTTP API)
  src/runner/MeetingRunner.ts        (state machine and timers)
  src/runner/launcher/MeetingRunnerLauncher.ts and implementations
  src/platform/PlatformAdapter.ts, GoogleMeetAdapter.ts, MicrosoftTeamsAdapter.ts, FakePlatformAdapter.ts
  src/audio/captureScript.ts         (in-page WebRTC hook)
  src/stt/SpeechToTextProvider.ts, SonioxRealtimeProvider.ts, FakeSpeechToTextProvider.ts
  src/speakers/SpeakerAttributor.ts
  src/callback/EventSender.ts
  scripts/fake-events.ts
```

**Structure Decision**: The feature is a vertical slice at `packages/features/notetaker`: repositories behind interfaces, services, DI modules and a Trigger.dev tasker. DTOs and the bot wire contract sit in `packages/lib`, so both the app and the bot can import them without crossing the dependency order. tRPC lives in `packages/trpc/server/routers/viewer/notetaker`, and every tRPC-using hook and component lives in `apps/web/modules/notetaker`. The in-meeting runtime is a separate deployable, `apps/notetaker-bot`. It depends only on `packages/lib/notetaker/botContract.ts` and talks to the app over the signed HTTP contract. That keeps it replaceable by Recall.ai through `INotetakerBotGateway`.

### Delivery sequence

| # | Title | Depends on | Code files (est.) |
|---|-------|------------|-------------------|
| 1 | `feat(notetaker): seed notetaker feature flag` | none | 2 |
| 2 | `feat(notetaker): add notetaker schema and migration` | none (approval gate) | 2 |
| 3 | `feat(notetaker): add DTOs and bot wire contract` | none | 6 |
| 4 | `feat(notetaker): add eligibility and limits config` | 3 | 4 |
| 5 | `feat(notetaker): add choice and session repositories` | 2 | 9 |
| 6a | `feat(notetaker): add transcript repository` | 2 | 4 |
| 6b | `feat(notetaker): add summary and activity repositories` | 2 | 7 |
| 7 | `feat(notetaker): add access and choice services` | 1, 4, 5, 6a, 6b | 8 |
| 8 | `feat(notetaker): add bot gateway with fake and self-hosted implementations` | 3 | 8 |
| 9 | `feat(notetaker): add dispatch and watchdog service` | 7, 8 | 4 |
| 10 | `feat(notetaker): add session event service and state machine` | 5, 6a, 6b | 6 |
| 11a | `feat(notetaker): add tasker scaffold` | 9 | 10 |
| 11b | `feat(notetaker): add scheduled dispatch task` | 11a | 3 |
| 12a | `feat(notetaker): add finalize service and task` | 10, 11b | 6 |
| 12b | `feat(notetaker): add summary generator` | 3 (dependency approval) | 5 |
| 12c | `feat(notetaker): add summary service and generation task` | 11a, 12a, 12b | 6 |
| 13 | `feat(notetaker): add bot events and cron routes` | 9, 10 | 7 |
| 14a | `feat(notetaker): add notification service and send-notification task` | 11b | 6 |
| 14b | `feat(notetaker): add admit-prompt and results-ready emails` | 14a | 7 |
| 14c | `feat(notetaker): add failed and turned-off emails` | 14a | 7 |
| 15 | `feat(notetaker): add attendee notification emails` | 14a | 7 |
| 16a | `feat(notetaker): add tRPC router scaffold with state and toggle procedures` | 7, 9 | 7 |
| 16b | `feat(notetaker): add stop and passages procedures` | 16a | 6 |
| 17a | `feat(notetaker): add sharing and delete procedures` | 16a, 12a | 9 |
| 17b | `feat(notetaker): add export and activity procedures` | 17a | 8 |
| 17c | `feat(notetaker): add event-type default and summary re-request procedures` | 17a, 12c | 8 |
| 18 | `feat(notetaker): hook booking creation, reschedule and location change` | 7 | 7 |
| 19 | `feat(notetaker): add booking toggle and status UI` | 16a, 16b | 7 |
| 20 | `feat(notetaker): add results page` | 17a, 17b, 19 | 8 |
| 21a | `feat(notetaker): add event-type default toggle` | 17c | 3 |
| 21b | `feat(notetaker): add booking-page disclosure` | 18 | 6 |
| 22 | `test(notetaker): add e2e with fake bot` | 20, 21a, 21b | 2 |
| 23 | `feat(notetaker): read the bot's Google account email from the environment` | 4 | 4 |
| 24 | `feat(notetaker): add the calendar guest gateway and booking calendar references` | 5 | 8 |
| 25 | `feat(notetaker): invite the bot's Google account to the calendar event at dispatch` | 23, 24, 7 | 10 |
| 26 | `docs(notetaker): record Google Meet account mode and amend FR-012` | 25 | 0 |
| B1 | `feat(notetaker-bot): scaffold service, contract client and fake adapter` | 3 (dependency approval) | 9 |
| B2 | `feat(notetaker-bot): add meeting runner state machine and timers` | B1 | 4 |
| B3 | `feat(notetaker-bot): add audio capture, Soniox provider and speaker attribution` | B2 | 8 |
| B4 | `feat(notetaker-bot): add Google Meet adapter` | B3 | 3 |
| B5 | `feat(notetaker-bot): add container launcher and deployment` | B2 | 4 |
| B6 | `feat(notetaker-bot): add Microsoft Teams adapter` | B4 | 3 |

Each PR is planned to stay within the constitution's limit of 500 changed lines and 10 code files. The estimates above come from the Source Code tree and count tests, but not documentation, lock files, generated files or the i18n JSON. A PR that grows past either limit during implementation must be split further rather than merged oversized. The bot track (B1-B6) runs in parallel with PRs 4-22. The schema PR (PR 2) includes the field `BookingNotetaker.notifiedAttendeeEmails` added by the design addendum.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New deployable `apps/notetaker-bot` whose long-running work is outside Trigger.dev | A real Chrome under Xvfb must stay in a meeting for up to 4 h; Trigger tasks here are capped at 600 s and have no browser or display | A Trigger.dev task or Next.js function cannot host it. Buying Recall instead removes the service but adds a media-holding vendor and per-hour cost, against the user's stated direction |
| Cron route `apps/web/app/api/cron/notetaker` duplicating the scheduled task's trigger | The sync fallback (`ENABLE_ASYNC_TASKER` off or no Trigger env) cannot run `schedules.task`; self-hosters would silently never dispatch | Trigger-only scheduling breaks installs that run in sync mode today |
| Dedicated `NotetakerActivity` table instead of `BookingAudit` | `BookingAudit` has no producers, is owner-only, and survives booking deletion | Reuse needs enum changes plus a class per action, and contradicts deleting history with the booking |

## Open items

[research.md](./research.md) lists 22 open questions with recommended defaults (it was 19 before the design addendum); the plan proceeds on those defaults unless the user decides otherwise. The early risks, including the speaker attribution spike that must run before SC-005 is promised, are also in [research.md](./research.md).
