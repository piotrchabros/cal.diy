# Research: Meeting Transcription Notetaker

Spec: [spec.md](./spec.md) | Plan: [plan.md](./plan.md) | Date: 2026-10-09

## Departures from the tech-stack note

The user's tech-stack note (`.herdr-web-ui/meeting-bot-tech-stack-20261008-213429-c7cfb9fe.md`) recommends a browser-based bot in TypeScript. The plan keeps that core recommendation: Node/TS, Playwright driving real Chrome under Xvfb in Docker, and Soniox realtime over WebSocket. It departs from the note in the places below.

| Note said | Plan does | Why |
|---|---|---|
| Orchestration with a BullMQ / Redis queue ("join meeting X at time T") | A Trigger.dev `schedules.task` sweep (`notetaker.dispatch-due-sessions`, every minute) with the database as the single source of truth. No BullMQ or Redis queue is added. | The project constitution mandates Trigger.dev for async work, and a second scheduler would compete with the database for state. The sweep also makes FR-006 and FR-008 hold without touching five booking code paths (Decisions 2 and 8). |
| Storage: Postgres plus S3 for audio | Postgres only. No audio or video is persisted anywhere and no object storage is used. | FR-030 forbids retaining audio or video once the transcript is produced. The bot forwards PCM frames to speech-to-text and discards them (Decisions 4 and 6). |
| Audio capture assumes per-participant tracks ("Per-participant tracks make diarization easy") | Per-participant tracks are treated as an unverified risk and a spike runs before SC-005 is promised. Speaker attribution combines contributing-source info, the meeting UI's active-speaker timeline and provider diarization as a fallback. | The designer believes Meet sends a small number of mixed "loudest speaker" streams, and Teams web is similar. This is unverified (see Risks to resolve early). |
| Scheduling through the Google Calendar API (and Microsoft Graph for Teams) to discover meeting links | Meeting links come from the application's own bookings (`Booking.metadata.videoCallUrl`, `BookingReference.meetingUrl`, `location`). No calendar API is called to discover meetings. | The spec limits eligible meetings to bookings made through this application (FR-001, Assumptions: "Eligible meetings"). Events that exist only on connected external calendars are out of scope. |
| Admission gotcha: use a signed-in Google account for the bot instead of joining anonymously | The plan keeps this for Google Meet (open question 3 asks who owns the account and whether automating it is acceptable). Teams joins as a guest. | The note's mitigation is retained; the account ownership and terms-of-service question is open. |
| Build vs. buy: own bot long-term, Recall.ai for fast validation | Build the own bot, but sequence all app-side work against `FakeBotGateway`. A `RecallBotGateway` is not built in v1 and remains a contingency behind `INotetakerBotGateway`. | The app side is identical either way, and the own bot keeps audio out of a third-party recorder (FR-030) (Decision 3). |

## Codebase findings

Facts below were verified by reading the repository. Paths are relative to the repository root.

- **Reschedule creates a new Booking row.** `fromReschedule = old.uid`; the old row becomes `CANCELLED` with `rescheduled: true` (`packages/features/bookings/lib/handleNewBooking/createBooking.ts:228-260`).
- **Seated owner reschedule moves `startTime` in place** (`packages/features/bookings/lib/handleSeats/reschedule/owner/moveSeatedBookingToNewTimeSlot.ts`). The start time must therefore be read live, never denormalised.
- **Booking events skip recurring occurrences.** `RegularBookingService.fireBookingEvents` (`packages/features/bookings/lib/service/RegularBookingService.ts:2588-2650`) calls `BookingEventHandlerService.onBookingCreated` and `onBookingRescheduled` only when `!isRecurringBooking`. The handler is `packages/features/bookings/lib/onBookingEvents/BookingEventHandlerService.ts`.
- **Recurring bookings** are N calls to `regularBookingService.createBooking` sharing `recurringEventId` (`packages/features/bookings/lib/service/RecurringBookingService.ts`).
- **Cancel, confirm/reject and location change** live in:
  - `packages/features/bookings/lib/handleCancelBooking.ts`
  - `packages/trpc/server/routers/viewer/bookings/confirm.handler.ts` and `packages/features/bookings/lib/handleConfirmation.ts`
  - `packages/trpc/server/routers/viewer/bookings/editLocation.handler.ts`
- **API v2 changes location through its own repository**, not `editLocationHandler` (`apps/api/v2/src/platform/bookings/2024-08-13/services/booking-location.service.ts`).
- **Location constants** (`packages/app-store/constants.ts`): `MeetLocationType = "integrations:google:meet"`, `MSTeamsLocationType = "integrations:office365_video"`, `DailyLocationType = "integrations:daily"`.
- **Meet falls back to Cal Video** when the destination calendar is not Google (`EventManager.ts:318`, `RegularBookingService.ts:1196`). The location type alone therefore does not prove the platform.
- **Where the join link is stored:**
  - `Booking.metadata.videoCallUrl` (`RegularBookingService.ts:2209`).
  - `BookingReference.meetingUrl` with type `google_meet_video` (`RegularBookingService.ts:1994, 2117`) or `office365_video`.
  - For Teams via Outlook, the `office365_calendar` reference (`EventManager.ts:251-262, 406`).
- **Booking audit is dormant.** The tables, viewer, `/booking/[uid]/logs` page and flag `booking-audit` exist, but no code outside `packages/features/booking-audit/` calls any `queue*Audit(` producer method. `BookingAuditAccessService` is owner-only.
- **`BookingAccessService`** (`packages/features/bookings/services/BookingAccessService.ts`) grants team admins access and keeps `isUserAHost` private. It is broader than FR-026's "hosts only".
- **Tasker pattern reference:** `packages/features/calendars/lib/tasker/` and `packages/features/calendars/di/tasker/`. Base class: `packages/lib/tasker/Tasker.ts`, which falls back to the sync tasker when `ENABLE_ASYNC_TASKER` or the Trigger environment is missing.
- **`packages/features/trigger.config.ts`:** `dirs` must list each task directory, and the global `maxDuration` is 600. It already lists two `./ee/...` directories that do not exist in this repository (pre-existing).
- **Trigger.dev SDK 4.3.2** types expose `delay` on trigger, `runs.cancel`, `runs.reschedule` and a `schedules` module. No code in the repository uses any of them yet.
- **Cal Video transcription** runs through `apps/web/app/api/recorded-daily-video/route.ts` and `CalVideoSettings`. This design does not touch it.
- **`CalVideoSettings`** is a 1:1 table keyed by `eventTypeId`; it is the precedent for per-event-type settings.
- **`packages/lib/dto/`** exists and holds three feature-flag DTOs.
- **Feature flags** are typed in `packages/features/flags/config.ts` (`AppFlags`) and seeded by migration.
- **Cron:** routes live in `apps/web/app/api/cron/*`; `apps/web/vercel.json` schedules them, one at `* * * * *`.
- **Cron authentication:** existing cron routes (for example `apps/web/app/api/cron/calendar-subscriptions/route.ts`) accept `CRON_API_KEY` or `Bearer ${CRON_SECRET}` in the `authorization` header, or `CRON_API_KEY` in the `apiKey` query parameter.
- **Emails:** a class in `packages/emails/templates/*.ts` (extends `BaseEmail`) plus a React template in `packages/emails/src/templates/*.tsx`. Web push is in `packages/features/notifications/sendNotification.ts`.
- **No LLM, speech-to-text, BullMQ or Playwright-runtime dependency exists** in any `package.json`. Only `@playwright/test` (dev), `@upstash/redis` (web) and `ioredis` (api v2) are present.

### Not verified

These items were not checked. The plan must not treat any of them as fact.

- Whether user deletion is a hard delete in code (the schema has `Booking.user onDelete: Cascade`).
- Semantics of `FeaturesRepository.checkIfUserHasFeature`.
- Whether `BookingDetailsSheet.tsx` is behind a flag.
- Whether API v2 create/cancel go through `RegularBookingService` / `handleCancelBooking`.
- Whether `packages/emails` imports from `packages/features`.
- The translation process for the other 43 locales.
- Soniox and Recall.ai API details.
- `schedules.task` running against this project's Trigger.dev plan.

## Decisions

### 1. Where the bot runs; app-to-bot contract

**Decision**

- The bot is a new workspace `apps/notetaker-bot` (package `@calcom/notetaker-bot`; the `apps/*` glob already covers it). It is a standalone Node/TS service with its own Dockerfile.
- It imports no `@calcom/features`, `@calcom/trpc` or `@calcom/prisma` and has no database access. The only shared code is `packages/lib/notetaker/botContract.ts` (Zod schemas plus HMAC helpers).
- One meeting per runner container. A small controller HTTP server receives join requests and launches runners through a `MeetingRunnerLauncher` interface.
- App to bot: signed HTTP (`POST /v1/sessions`, `POST /v1/sessions/:sessionId/stop`, `GET /v1/sessions/:sessionId`).
- Bot to app: signed HTTP POSTs to `apps/web/app/api/notetaker/events/route.ts`, carrying status events and batched transcript passages streamed during the meeting.
- Both directions use HMAC-SHA256 with the shared secret `NOTETAKER_BOT_SECRET` over `timestamp + "." + rawBody`, with a 5-minute tolerance. Events carry `eventId` (idempotency) and a per-session `sequence`.
- The events route answers `410 Gone` for an unknown or terminal session, and the bot must leave on 410. This is the kill switch.

**Rationale**

- A 4-hour real-Chrome/Xvfb process fits neither a Next.js function nor a Trigger.dev machine (`maxDuration: 600`).
- Keeping the bot in the same repository keeps the contract and its tests in one PR flow, and having no database access keeps the bot swappable.
- Streaming passages means a bot crash still leaves partial content (FR-011).

**Alternatives considered**

- Separate repository: contract drift and two release trains.
- Bot writes to Postgres directly: breaks the repository and DTO rules and couples deployments.
- Bot inside a Trigger.dev task: duration and browser limits.
- WebSocket or Redis stream back to the app: more infrastructure for no v1 benefit.

### 2. Orchestration: Trigger.dev vs BullMQ

**Decision**

- The app owns scheduling via Trigger.dev, with the database as the single source of truth. There is no BullMQ/Redis queue in the monorepo.
- A `schedules.task` `notetaker.dispatch-due-sessions` (cron `* * * * *`, UTC) runs `NotetakerDispatchService.dispatchDue()`. Each run does three things:
  1. Dispatches bookings whose choice is enabled, armed (`pendingDispatch`), `ACCEPTED` and eligible, with start at or before now + `NOTETAKER_JOIN_LEAD_SECONDS`.
  2. Voids choices whose booking is still unconfirmed at start.
  3. Acts as watchdog: stops or fails sessions whose booking is no longer `ACCEPTED`, and marks sessions with a lost heartbeat as `INTERRUPTED`. When it removes a pre-admission session because the booking is no longer `ACCEPTED`, it also voids the choice (`enabled = false`, `pendingDispatch = false`, system `DISABLED` activity with `detail.reason = "BOOKING_NOT_ACTIVE"`).
- The session row is created (`SCHEDULED`) before the gateway call. A 422 turns it into `FAILED` / `MEETING_LINK_UNUSABLE`; a timeout (10 s), network error or 5xx deletes the row and sets `pendingDispatch = true`, so the choice is re-armed for the next sweep.
- Give-up deadline: at `min(booking.endTime, max(startTime, setAt) + NOTETAKER_NO_SHOW_TIMEOUT_SECONDS)` a still-armed choice gets a `FAILED` / `INTERRUPTED` session, `pendingDispatch = false` and a `FAILED` notice, so an unreachable bot service never leaves a choice armed forever.
- Enabling inside the lead window dispatches immediately from the mutation.
- Lifecycle changes (cancel, reject, confirm, reschedule, in-place time move) need no per-booking run bookkeeping, because every decision re-reads current booking state.
- Retries: the gateway call is retried by the next sweep (a transient failure deletes the session row and re-arms the choice, until the give-up deadline); post-processing retries come from task `retry` config.
- The bot owns the in-room timers (10 min admission, 15 min no-show, 2 min alone, 4 h max, single rejoin) because only it sees the room. The app sends the limits in each join request and the watchdog is the backstop.
- When Trigger.dev is not configured, `apps/web/app/api/cron/notetaker/route.ts` calls the same service.

**Rationale**

- The constitution mandates Trigger.dev for async work, and a second scheduler would compete with the database.
- The sweep makes FR-006 and FR-008 hold without touching five booking code paths, and gives SC-008 (no silent failures) a single owner.

**Alternatives considered**

- BullMQ per the note: violates the constitution and duplicates state.
- Per-booking delayed Trigger run with `runs.reschedule` / `runs.cancel`: needs run-id bookkeeping in every lifecycle path, has no sync-fallback equivalent, and is unused in this repository.
- Legacy `packages/features/tasker` with `scheduledAt`: not the mandated pattern.

### 3. Build vs buy

**Decision**

- Build the own bot, as the note directs. Sequence the work so every app-side PR runs against `FakeBotGateway` first.
- The app talks only to `INotetakerBotGateway`. `NotetakerBotGatewayFactory` picks the implementation from `NOTETAKER_BOT_PROVIDER` = `self_hosted` | `fake` | `recall`.
- `RecallBotGateway` is not built in v1. It would add one webhook route translating Recall events into the same `NotetakerBotEvent` and nothing else.

**Rationale**

- The app side (most of the PRs) is identical either way.
- The own bot keeps audio out of a third-party recorder (FR-030) and avoids per-hour cost.
- Recall remains a contingency if Meet admission or selector work stalls.

**Alternatives considered**

- Recall first: faster P1, but adds a vendor that stores media by default, a per-hour cost and a second integration to retire.
- Forking Attendee or Vexa: Python stacks; use them as references only.

### 4. Speech-to-text and diarization

**Decision**

- Speech-to-text lives in the bot behind a `SpeechToTextProvider` interface; the v1 implementation is `SonioxRealtimeProvider` (WebSocket, 16 kHz PCM).
- The bot captures incoming WebRTC audio in the page and never writes audio to disk. It forwards PCM frames to speech-to-text and discards them.
- A `SpeakerAttributor` attributes each utterance by combining:
  1. the audio stream's contributing-source info where available,
  2. the meeting UI's active-speaker timeline (DOM),
  3. as fallback, the provider's diarization labels mapped to numbered unknown speakers.
- No name is ever guessed: an unresolved speaker becomes `unknownSpeakerNumber = n` (FR-009).
- Language is tagged per passage when the provider supplies it.

**Rationale**

- Per-stream capture plus the UI speaker timeline is the cheapest route to SC-005.
- The provider interface keeps Deepgram and AssemblyAI swappable.

**Alternatives considered**

- Mixed audio through a PulseAudio sink with diarization only: yields no names.
- Post-meeting batch speech-to-text: needs stored audio, which FR-030 forbids.

The spike this decision depends on is described under Risks to resolve early.

### 5. Summary generation

**Decision**

- Interface `INotetakerSummaryGenerator.generate({ passages, languageHint }): Promise<NotetakerSummaryResult>` in the feature slice.
- The v1 implementation `AnthropicSummaryGenerator` uses `@anthropic-ai/sdk`, which is a new dependency in `packages/features` and needs approval.
- The default model is `claude-opus-5-5`, configurable through `NOTETAKER_SUMMARY_MODEL`. Any other model is an operator choice through that variable.
- Output is constrained to a Zod schema through the SDK's structured-output support and validated again on receipt. Streaming is used for long inputs.
- Output shape: `{ language: string, overview: string, keyPoints: string[], decisions: string[], actionItems: { text: string, owner: string | null }[] }`.
- Prompt rules: write in the predominant spoken language (FR-019; the hint is duration-weighted passage language, otherwise the model infers it); owners only where stated; no invention.
- "Too little speech" is decided in code before any call: fewer than `NOTETAKER_SUMMARY_MIN_WORDS` (default 40) gives status `NOT_ENOUGH_CONTENT`.
- `stop_reason: "refusal"` or a schema failure gives `FAILED` with a `failureCode`.
- Task `notetaker.generate-summary` retries 3 times. A host re-request (FR-022) is allowed when the summary status is `FAILED`, or when no summary row exists while a transcript does; it upserts the row to `PENDING`. `PENDING`, `READY` and `NOT_ENOUGH_CONTENT` are refused as a bad request.
- The whole transcript goes in one request: a 4-hour meeting is about 36k words (about 60k tokens).

**Rationale**

- Summary quality drives SC-006.
- An interface plus an env-configured model keeps the provider replaceable.

**Alternatives considered**

- `lingo.dev` (stated by the design to be already a dependency; not verified in this research): a translation tool, not a summariser.
- Chunked map-reduce: unnecessary at these sizes.
- Summarising in the bot: couples the LLM to the bot and blocks re-requests.

### 6. Storage

**Decision**

- Postgres only: eight new tables (see `data-model.md`; `BookingNotetaker` also carries `notifiedAttendeeEmails`, a per-attendee notice record, which does not add a table). Passages are rows keyed `(transcriptId, index)`; summary lists are JSON validated by Zod.
- No audio or video is persisted anywhere and no S3 is used; the note's "S3 (audio)" is dropped (FR-030).
- Size expectations:
  - 60 minutes: about 9k words, 250 to 400 passages, about 60 KB.
  - 4 hours: about 36k words, 1,000 to 3,000 passages, under 0.5 MB.
- The bot caps a passage at 60 s or 1,000 characters.
- Reads are cursor-paginated (default 200, max 500).

**Rationale**

- The data is small and relational, and it cascades with the booking (FR-029). Row-per-passage gives ordered, idempotent ingestion.

**Alternatives considered**

- One JSON blob per transcript: no idempotent append and large rewrites.
- Object storage for text: extra infrastructure with no benefit.

### 7. Eligibility detection

**Decision**

Pure functions in `packages/features/notetaker/lib/eligibility.ts`.

- `resolveMeetingLink({ location, metadata, references })` picks, in order:
  1. `metadata.videoCallUrl`
  2. a non-deleted `BookingReference.meetingUrl` of type `google_meet_video`, `office365_video` or `office365_calendar`
  3. `location`, if it starts with `http`.
- `classifyMeetingUrl(url)` returns `GOOGLE_MEET` for host `meet.google.com`, `MICROSOFT_TEAMS` for `teams.microsoft.com` or `teams.live.com`, otherwise `null`.
- Before a link exists (pending booking), eligibility is provisional, from the location type (`MeetLocationType` / `MSTeamsLocationType`).
- Cal Video (`DailyLocationType`, reference type `daily_video`, or a Cal video URL) is never eligible and returns reason `CAL_VIDEO` (FR-032).
- Event-type default: available when at least one configured location is a supported type. It applies only to bookings that end up on a supported platform.
- `MICROSOFT_TEAMS` is additionally gated by `NOTETAKER_ENABLED_PLATFORMS` (default `GOOGLE_MEET`).

**Rationale**

- Because of the Meet-to-Cal-Video fallback, the URL is the only reliable signal. It also covers hosts who paste a Meet or Teams link as a custom link location.

**Alternatives considered**

- Location type only: wrong after the fallback.
- App-store credential checks: irrelevant, since the bot joins as a guest.

### 8. Booking lifecycle hooks

**Decision**

Hooks are added only where the table below lists one (it lists four); everything else is handled by the sweep.

| Event | Mechanism |
|---|---|
| Booking created | `BookingEventHandlerService.onBookingCreated` calls `NotetakerChoiceService.onBookingCreated` (applies the event-type default) |
| Reschedule (new row) | `BookingEventHandlerService.onBookingRescheduled` calls `onBookingRescheduled` (copies the choice from `oldBooking.uid`; overrides the default) |
| Recurring occurrences | `fireBookingEvents` gains a recurring branch calling a new `BookingEventHandlerService.onRecurringOccurrenceCreated` (notetaker default only) |
| Location change (web) | `editLocation.handler.ts`, after `updateBookingLocationInDb`, calls `NotetakerChoiceService.onBookingLocationChanged` (re-check; if unsupported, disable and email the host) |
| Cancel / reject | No hook. Dispatch requires `ACCEPTED`; the watchdog stops any active session within a minute; the read model treats the choice as void |
| Confirm | No hook. The sweep sees `ACCEPTED` |
| Still unconfirmed at start | The sweep sets `enabled = false` with a system `DISABLED` activity (`detail.reason = "BOOKING_NOT_CONFIRMED"`) |
| Seated in-place time move | No hook. The start time is read live |
| "All future occurrences" | `setEnabled` with scope `ALL_FUTURE_OCCURRENCES` upserts choices for bookings with the same `recurringEventId` and `startTime` at or after this one |

**Rationale**

- This keeps edits to the 2,690-line `RegularBookingService` minimal, and correctness does not depend on catching every path, including API v2 and calendar-sync cancels.

**Alternatives considered**

- Hooks in every path (cancel, confirm, seats, API v2, calendar sync): about six touch points and easy to miss one.
- Deriving the default at dispatch time: breaks "changing the default leaves existing bookings unchanged".

An API v2 location change does not call the hook, and this is handled at dispatch. If the new location is unsupported, dispatch turns the choice off (`DISABLED`, system actor, `detail.reason = "UNSUPPORTED_LOCATION"`) and the host gets a turned-off notice. If the location type is supported but has no usable link, the session ends as `FAILED` with reason `MEETING_LINK_UNUSABLE` and the host gets a failed notice.

### 9. Notifications

**Decision**

- Email through the existing `packages/emails` pattern (six new templates, catalog in `contracts/notifications.md`), sent by task `notetaker.send-notification`.
- The "please admit" prompt also uses the existing web push (`sendNotification`) and an in-app banner driven by status polling.
- Recipients for host notices: distinct users with an `ENABLED` activity on the booking; when the choice was inherited (no user), the organizer.
- The attendee notice (FR-014) is a separate `ATTENDEE_NOTICE` email, deduplicated per attendee: recipients are the current `Attendee.email` values, minus the booking's own `BookingNotetaker.notifiedAttendeeEmails`, minus those of bookings sharing the same non-null `recurringEventId`. It has three triggers: the host enables (off to on); a booking is created with the inherited default; and every dispatch, as a catch-all. Guests and attendees added later are therefore told before the meeting, about two minutes before start at the latest, as User Story 2 and FR-014 require. No hook is added to `addGuests` or `handleSeats`.
- Session-scoped host notices (`ADMIT_PROMPT`, `RESULTS_READY`, `FAILED`) are sent once per session, enqueued only on the winning status transition with Trigger idempotency key `notetaker:<KIND>:<sessionId>`.
- No notification contains transcript text (FR-020).

**Rationale**

- Reuses the mail transport, locale handling and push subscriptions; no new channel.

**Alternatives considered**

- Workflows: removed from this fork (migration `drop_workflow_tables`).
- A new in-app notification centre: out of scope.

### 10. Access, sharing, deletion, activity

**Decision**

- **Access:** `NotetakerAccessService` decides the viewer role.
  - `HOST` is the organizer (`booking.userId`), or an event-type host or user who is also an attendee of the booking (same rule as `isUserAHost`). Team and org admins are not hosts.
  - `ATTENDEE` is a signed-in user whose email (primary or verified secondary) matches an `Attendee.email`, and only while a `NotetakerSharingGrant` row exists.
  - Everyone else gets `ErrorWithCode.Factory.Forbidden`.
- **Sharing:** create or delete the grant row. Revocation is immediate because every read checks it.
- **Delete (FR-028):** hard-delete transcript, passages and summary, set `NotetakerSession.resultsDeletedAt`, and delete the sharing grant.
- **Cascade (FR-029):** every table has a foreign key to `Booking` or a parent with `onDelete: Cascade`; the booking cascades from `User`.
- **Activity (FR-031):** a dedicated `NotetakerActivity` table. `BookingAudit` is not reused. Event-type default changes are not part of the booking activity history (the only trace is `EventTypeNotetakerSettings.updatedAt`); a booking that inherits the default records a system `ENABLED` activity (`detail.source = "EVENT_TYPE_DEFAULT"`).

**Rationale**

- `BookingAudit` has no producers wired in this fork and is owner-only. Reusing it would need enum additions plus an action-service class per action. It also deliberately outlives the booking, which conflicts with deleting everything with the booking.

**Alternatives considered**

- Extend `BookingAuditAction`: heavier, wrong retention, wrong access rule.
- Tokenised attendee links: effectively public links, which the spec excludes.

### 11. Public surface

**Decision**

- **Web:** a new tRPC router `viewer.notetaker` (11 procedures) and one public procedure `publicViewer.notetakerDisclosure`.
- **API v2 and webhooks:** nothing in v1. No new `WebhookTriggerEvents` value, no change to booking payloads or the OpenAPI document. FR-033 holds by not touching them.
- **Machine endpoints:** `POST /api/notetaker/events` (HMAC) and `GET /api/cron/notetaker` (cron key). Neither is a public API.
- **Booking page (US5):** `NotetakerDisclosure` in the Booker shows "This meeting will be transcribed by an automated notetaker on behalf of {host}" before confirming, when the default is on and the selected location is supported.

**Rationale**

- Additive-only is easiest to guarantee by adding nothing. Exhaustive enum handling in API v2 makes a new webhook trigger a multi-package change that deserves its own spec.

**Alternatives considered**

- A `NOTETAKER_TRANSCRIPT_READY` webhook plus a date-versioned `GET /v2/bookings/:uid/transcript`: recommended follow-up, not v1.
- Adding a field to `getPublicEvent`: touches a 787-line shared select used by API v2.

### 12. Rollout and limits

**Decision**

- Feature flag slug `notetaker`: seeded by migration with `enabled = false`, type `RELEASE`, and added to `AppFlags`. Checked per acting host in services and in `getState` (`featureEnabled`).
- Limits are env vars read in `packages/features/notetaker/lib/config.ts` and sent to the bot per session.

| Variable | Default |
|---|---|
| `NOTETAKER_ADMISSION_TIMEOUT_SECONDS` | 600 |
| `NOTETAKER_NO_SHOW_TIMEOUT_SECONDS` | 900 |
| `NOTETAKER_ALONE_TIMEOUT_SECONDS` | 120 |
| `NOTETAKER_MAX_DURATION_SECONDS` | 14400 |
| `NOTETAKER_JOIN_LEAD_SECONDS` | 120 |
| `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS` | 180 |
| `NOTETAKER_SUMMARY_MIN_WORDS` | 40 |
| `NOTETAKER_ENABLED_PLATFORMS` | `GOOGLE_MEET` |
| `NOTETAKER_BOT_PROVIDER` | `fake` in dev/test |

- Provider values are exact lowercase: `self_hosted` maps to `SELF_HOSTED`, `recall` to `RECALL`, `fake` to `FAKE`. Unset means `fake` when `NODE_ENV !== "production"`.
- In production, an unset value, `fake` (unless `NEXT_PUBLIC_IS_E2E` is set) or `recall` (not built in v1) makes the feature report disabled (`featureEnabled = false`, reason `FEATURE_DISABLED`); the sweep does nothing and logs an error.
- Other variables: `NOTETAKER_BOT_URL`, `NOTETAKER_BOT_SECRET`, `NOTETAKER_SUMMARY_MODEL`, `ANTHROPIC_API_KEY`, `NOTETAKER_FAKE_SCENARIO`.
- Bot-side: `SONIOX_API_KEY` and the bot Google account credentials.
- All must be added to `turbo.json` `globalEnv` and `.env.example`, including `NOTETAKER_FAKE_SCENARIO`.

**Rationale**

- The spec calls the limits tunable product defaults and has no per-org policy, so env config is the simplest thing that works.

**Alternatives considered**

- A database settings table or per-team limits: speculative.

### 13. Testing

**Decision**

- **Vitest unit** (target near 100% on services): eligibility, the state-machine transition table, choice service (default, reschedule carry-over, recurring scope), dispatch and watchdog with a fixed clock, event ingestion (idempotency, ordering, 410), finalize mapping, summary service with a stub generator, access service, export, HMAC helpers, tasker dispatch. Repositories are replaced by in-memory fakes that implement the repository interfaces (per `agents/rules/testing-mocking.md`).
- **Integration tests** (`*.integration-test.ts`): the dispatch compare-and-swap (no double session), cascade delete, passage upsert idempotency.
- **Route tests:** signature, timestamp tolerance, and schema validation for the events route.
- **Playwright E2E** (one file, `apps/web/playwright/notetaker.e2e.ts`, with three tests under `test.describe("Notetaker")` and `NOTETAKER_BOT_PROVIDER=fake`):
  - host enables, status reaches ready, host sees transcript and summary;
  - share and revoke as an attendee;
  - event-type default plus booking-page disclosure.
- **Bot:** runner state machine and timers against `FakePlatformAdapter` and `FakeSpeechToTextProvider`. Real Meet/Teams adapter smoke tests are manual or nightly and not part of CI.
- All runs use `TZ=UTC`. Running the E2E suite is an approval gate.
- **Faking the bot:** `FakeBotGateway` emits a scripted event sequence through `NotetakerSessionEventService`, chosen by `NOTETAKER_FAKE_SCENARIO`: `happy` | `not_admitted` | `meeting_did_not_start` | `no_speech` | `removed_by_participant` | `interrupted` | `length_limit` | `link_unusable` | `manual`. With `manual`, the script `apps/notetaker-bot/scripts/fake-events.ts` posts signed events to the real route, which exercises the HTTP contract.

**Rationale**

- Fakes at the gateway and platform-adapter seams let every app-side and runner behaviour be tested without a real meeting, while the `manual` scenario still exercises the signed HTTP contract.

**Alternatives considered**

- Testing only against real Meet/Teams meetings: not reproducible in CI and subject to selector breakage.
- Deep mocks of repositories: rejected by `agents/rules/testing-mocking.md` in favour of simple fakes.

## Risks to resolve early

1. **Speaker attribution may not be feasible as the note assumes.** The note assumes one audio track per participant. The designer's own knowledge, which is not from the repository or the note and is unverified, is that Google Meet sends a small number of mixed "loudest speaker" streams rather than one track per participant, and Teams web is similar. If that holds, SC-005 (at least 90% of passages attributed to the correct speaker in meetings of up to 8 participants) cannot be promised on audio alone. A spike must run before SC-005 is committed to, in PR B3 (audio capture, Soniox provider and speaker attribution). The spike also covers Soniox per-token language and diarization output, which are likewise unverified.
2. **Admission and selector breakage.** The note lists two gotchas that apply directly. First, someone must admit the bot from "Ask to join", which is why the plan prompts the host (FR-025) and uses a signed-in Google account for Meet (open question 3). Second, UI selectors break when Google or Microsoft change their pages, so the plan budgets maintenance time, monitors join failures through `MEETING_LINK_UNUSABLE` and `NOT_ADMITTED` outcomes, and keeps real Meet/Teams adapter smoke tests manual or nightly rather than in CI. `RecallBotGateway` stays available behind `INotetakerBotGateway` as a contingency if admission or selector work stalls.
3. **API v2 location changes bypass the location hook.** API v2 changes a booking's location through its own repository, not `editLocationHandler`, so `NotetakerChoiceService.onBookingLocationChanged` is not called. This is handled at dispatch: an unsupported location turns the choice off with a turned-off notice, and a supported type with no usable link ends as `FAILED` / `MEETING_LINK_UNUSABLE`. The remaining cost is that the host learns about it shortly before the meeting rather than when the location changes (Decision 8, open question 15).

## Approval gates

The project constitution requires explicit approval for schema changes, new dependencies and multi-package changes. The following must be approved before implementation starts.

1. `schema.prisma` change: 8 models, 9 enums, and back-relations on `Booking` and `EventType`.
2. New dependency `@anthropic-ai/sdk` in `packages/features`.
3. New workspace `apps/notetaker-bot` with runtime dependencies `playwright`, `ws` and a launcher client.
4. Multi-package change (prisma, lib, features, trpc, emails, i18n, apps/web).
5. Running the E2E suite.
6. Edits to the shared booking code paths `RegularBookingService.fireBookingEvents`, `BookingEventHandlerService` and `editLocation.handler.ts`.

## Design addendum

23 points left open by the first design pass were settled and are reflected in `data-model.md` and `contracts/`; the ones that changed a decision above are the attendee notice (Decision 9), the outcome mapping, join-failure and give-up handling (Decisions 2 and 8), and the summary re-request rule (Decision 5).

## Open questions

The plan proceeds on the recommended default for each question below unless the user says otherwise.

| # | Question | Recommended default | Blocks |
|---|---|---|---|
| 1 | Build own bot first, or validate with Recall.ai? | Own bot; the app is built against the fake gateway either way. | Bot track (B1 onward); not the app track |
| 2 | Bot hosting and launcher: single Docker host on Hetzner, or Kubernetes Jobs? | Docker host with one container per meeting via the controller; child-process launcher for local dev. | PR B5 (container launcher and deployment) |
| 3 | Bot identity: who owns the signed-in Google account, and is automating it acceptable under Google's terms? Teams joins as a guest. | Dedicated Workspace account. | PR B4 (Google Meet adapter) in production |
| 4 | Vendor data terms: audio goes to Soniox and transcript text to Anthropic. Are DPAs and zero or short retention confirmed? | Required before production. | Production rollout |
| 5 | Summary model. | `claude-opus-5-5` via `NOTETAKER_SUMMARY_MODEL`; operator may choose a cheaper tier. | PR 12b (summary generator) default config |
| 6 | How do attendees without an account view shared results? | v1: signed-in user whose email matches an attendee; an emailed one-time code is a follow-up. | PR 17a (sharing procedures) |
| 7 | Export format. | Markdown; PDF/DOCX later. | PR 17b (export procedure) |
| 8 | Do team/org admins see transcripts? | No; hosts only per FR-026, which is stricter than `BookingAccessService`. | PR 7 (access service) |
| 9 | Booking cancelled while the notetaker is in the meeting. | Treat as host stop; keep any content as ended early. | PR 9 (dispatch and watchdog service) |
| 10 | Mapping of non-complete outcomes. | Length limit gives `READY` + `TRUNCATED`; interruption or removal with content gives `ENDED_EARLY` + `PARTIAL`; any outcome with no content gives `FAILED`. | PR 10 (state machine) and PR 12a (finalize) |
| 11 | Language of the display name and in-meeting notice. | Organizer's locale. | PR 9 (join request) and PR 14a-14c (emails) |
| 12 | Does the activity history survive booking deletion? | No; it cascades. | PR 6b (activity repository) and the schema migration |
| 13 | Can a host retry after a failed attempt? | Yes, by re-enabling, except after removal or host stop. | PR 7 (choice service) |
| 14 | Which hosts get notices when the choice was inherited from the default? | The organizer. | PR 14a (notification service) |
| 15 | API v2 location changes bypass the hook. | `TURNED_OFF` at dispatch. | PR 18 (booking hooks) scope |
| 16 | Flag granularity. | Global plus per-user; `checkIfUserHasFeature` semantics to be confirmed. | PR 1 (flag seed) and PR 7 (flag checks) |
| 17 | Seated events. | Supported; the notice goes to all attendees. | PR 15 (attendee notification emails) |
| 18 | Speaker attribution feasibility on Meet and Teams. Soniox language and diarization output was confirmed on 2026-10-09 against the real API with a clean two-speaker sample (per-token `speaker` and `language`; see `apps/notetaker-bot/docs/verification-status.md`); it has not been measured on audio captured from a meeting. | Spike in B3 before committing to SC-005. | Committing to SC-005; PR B3 |
| 19 | Several transcripts on one booking after a retry. | Show the latest session; earlier attempts in a collapsed list. | PR 20 (results page) |
| 20 | Give-up reason when the bot service cannot be reached before the deadline. A clearer "notetaker unavailable" reason would add a ninth value to FR-024's fixed list, which is a spec change. | `INTERRUPTED`. | PR 9 (dispatch and watchdog service); any change to FR-024's list |
| 21 | Late-added attendees (guests, new seats). Notifying them when they are added needs two more edits to shared booking paths (`addGuests`, `handleSeats`). | Notice at dispatch, about two minutes before start. | PR 15 (attendee notification emails) and PR 18 (booking hooks) scope |
| 22 | Event-type "disable all emails" setting (`DisableAllEmailsSetting.tsx`); how it is applied was not read. | The attendee notice is sent regardless, because it is a transparency requirement. | PR 15 (attendee notification emails) |
