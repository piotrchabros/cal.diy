# Contract: Background Tasks (Trigger.dev)

Spec: [../spec.md](../spec.md) · Data model: [../data-model.md](../data-model.md) · Notifications: [notifications.md](./notifications.md)

## Scope

- Location: `packages/features/notetaker/lib/tasker/`. Task definitions live in `packages/features/notetaker/lib/tasker/trigger/`.
- Queue name: `notetaker`.
- `packages/features/trigger.config.ts` must list the new task directory in `dirs`: add `"./notetaker/lib/tasker/trigger"`.
- The long-running in-meeting work is NOT a task. Joining the room, capturing audio, streaming speech-to-text and the in-room timers (admission, no-show, alone, maximum duration, single rejoin) run in the bot service (`apps/notetaker-bot`). Tasks here are capped at 600 seconds (global `maxDuration` in `packages/features/trigger.config.ts`) and only do short database, LLM and email work.
- The database is the single source of truth. Tasks re-read current booking and session state on every run; no task keeps per-booking run bookkeeping.

## Tasks

| Task id | Kind | Payload | Does |
|---|---|---|---|
| `notetaker.dispatch-due-sessions` | `schedules.task`, cron `* * * * *` | none | `NotetakerDispatchService.dispatchDue()` |
| `notetaker.finalize-session` | `schemaTask` | `{ sessionId: string }` | Completeness, language, status mapping; then queues summary and notification |
| `notetaker.generate-summary` | `schemaTask` | `{ transcriptId: string, requestedByUserId: number \| null }` | `NotetakerSummaryService.generate` |
| `notetaker.send-notification` | `schemaTask` | `{ kind: NotetakerNotificationKind, bookingId: number, sessionId: string \| null }` | `NotetakerNotificationService.send` |

All four use the shared queue, machine and retry configuration from `trigger/config.ts` and import their services dynamically inside `run`.

### Who enqueues what

| Task / kind | Enqueued by |
|---|---|
| `finalize-session` | `NotetakerSessionEventService` on a post-admission `session.ended`; `NotetakerDispatchService` on post-admission heartbeat loss and on stop→404. Never for pre-admission ends |
| `generate-summary` | `NotetakerFinalizeService` when the result is `READY` or `ENDED_EARLY` and the word count is sufficient; `NotetakerSummaryService` on re-request |
| `ATTENDEE_NOTICE` | `NotetakerChoiceService` (off→on, inherited creation); `NotetakerDispatchService` at dispatch |
| `ADMIT_PROMPT` | `NotetakerSessionEventService` on the transition into `WAITING_TO_BE_ADMITTED` |
| `RESULTS_READY` | `NotetakerSummaryService` when the first generation settles (`READY`, or `FAILED` once `attempts` reaches 3); `NotetakerFinalizeService` when it sets `NOT_ENOUGH_CONTENT` |
| `FAILED` | `NotetakerSessionEventService` (pre-admission); `NotetakerFinalizeService` (zero passages); `NotetakerDispatchService` (422, missing link, give-up, watchdog) |
| `TURNED_OFF` | `NotetakerChoiceService.onBookingLocationChanged`; `NotetakerDispatchService` |
| `SHARED_WITH_ATTENDEES` | `NotetakerResultsService.setSharing` |

Session-scoped kinds (`ADMIT_PROMPT`, `RESULTS_READY`, `FAILED`) are enqueued only on the winning status transition, with the Trigger idempotency key `notetaker:<KIND>:<sessionId>`, so each is sent once per session.

### `notetaker.dispatch-due-sessions`

**Trigger.** Cron `* * * * *`, timezone UTC (`schedules.task`). Not enqueued by anyone; it is the sweep that makes the database authoritative. Enabling a choice inside the join lead window additionally dispatches immediately from the tRPC mutation (same service method path), so the sweep is the backstop rather than the only path.

**Payload.** None.

**What `NotetakerDispatchService.dispatchDue()` does.** When the bot provider is unusable in production (`NOTETAKER_BOT_PROVIDER` unset, `fake` without `NEXT_PUBLIC_IS_E2E`, or `recall`), the feature reports disabled: the sweep does nothing and logs an error. Otherwise each run does three things:

1. Dispatches due bookings.
   1. Select choices (`BookingNotetaker`) that are `enabled` and armed (`pendingDispatch = true`), whose booking is `ACCEPTED`, on a platform in `NOTETAKER_ENABLED_PLATFORMS` and not past `endTime`, with booking start less than or equal to now + `NOTETAKER_JOIN_LEAD_SECONDS`. The candidate query is indexed on booking start and `@@index([enabled, pendingDispatch])`.
   2. Check the dispatch precondition: no session for the booking in `SCHEDULED`, `WAITING_TO_BE_ADMITTED`, `TRANSCRIBING` or `PROCESSING`.
   3. Win the atomic compare-and-swap: `updateMany where bookingId AND pendingDispatch = true` setting `pendingDispatch = false`. Only the run whose update affects one row continues. Every other concurrent run (a second sweep, the immediate dispatch from the mutation, a manual cron-route call) sees zero rows and skips the booking. This is what guarantees one session per booking (FR-008), however many hosts enabled it.
   4. Check eligibility at dispatch time:
      1. No meeting link, but the location type is supported: create a `FAILED` / `MEETING_LINK_UNUSABLE` session (platform from the location type, empty `meetingUrl`) and enqueue a `FAILED` notice.
      2. Location unsupported: turn the choice off (`DISABLED`, actor `SYSTEM`, `detail.reason = "UNSUPPORTED_LOCATION"`) and enqueue a `TURNED_OFF` notice.
   5. Resolve the current meeting link at that moment (FR-007), create the `NotetakerSession` row (`SCHEDULED`) and call `gateway.requestJoin` with the per-session limits. The row exists before the gateway call. The request timeout is 10 seconds.
   6. Handle the gateway result:
      1. `422`: the session becomes `FAILED` / `MEETING_LINK_UNUSABLE` with `endedAt = now`, and a `FAILED` notice is enqueued.
      2. Timeout, network error, `5xx` or `503`: delete the session row and set `pendingDispatch = true`; the next sweep retries.
   7. Give-up: at `min(booking.endTime, max(startTime, setAt) + NOTETAKER_NO_SHOW_TIMEOUT_SECONDS)` a still-armed choice gets a `FAILED` / `INTERRUPTED` session, `pendingDispatch = false` and a `FAILED` notice.
2. Voids choices for bookings still unconfirmed at start, so a late confirmation does not start a notetaker in a meeting already under way. It applies to a booking in `PENDING` or `AWAITING_HOST` with `startTime` at or before now. Voiding a choice:
   1. Sets `enabled = false` and `pendingDispatch = false`; every other field of the choice is unchanged.
   2. Writes an activity row `DISABLED` with `actorType = SYSTEM` and `detail.reason = "BOOKING_NOT_CONFIRMED"`.
   3. Sends no notification and creates no session.
   4. A cancelled or rejected booking with no session is not written to; the read model treats it as void.
3. Acts as watchdog. "Before admission" means `admittedAt` is null (`SCHEDULED`, `WAITING_TO_BE_ADMITTED`); "after admission" means `admittedAt` is set (`TRANSCRIBING`).
   1. Booking no longer `ACCEPTED`, before admission: stop requested (best effort), session row deleted, no transcript, no notice, and the choice is voided as above with `detail.reason = "BOOKING_NOT_ACTIVE"`.
   2. Booking no longer `ACCEPTED`, after admission: stop requested (ends as `STOPPED_BY_HOST`/`INTERRUPTED` through the normal finalize path).
   3. Heartbeat lost: no event for `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS`, measured from the later of `dispatchedAt` and `lastHeartbeatAt`. The watchdog also calls `requestStop` best-effort.
      1. Before admission: the session becomes `FAILED` / `INTERRUPTED`.
      2. After admission: the session becomes `PROCESSING` with a provisional `outcomeReason` of `INTERRUPTED`, and `finalize-session` is enqueued. Finalize yields `ENDED_EARLY` / `INTERRUPTED` with one or more passages and `FAILED` / `INTERRUPTED` with none. If `interruptedAtMs` is still null, finalize sets it to the last passage's `endMs`, or 0.
   4. Stop requested and the bot answers `404`: `requestStop` resolves and the watchdog path applies at once. Before admission the row is already deleted. After admission the session goes to `PROCESSING` with a provisional `STOPPED_BY_HOST`, and `finalize-session` is enqueued.

**Batch bound.** Work per run is bounded: a batch of 200 per step, ordered by booking start. Anything beyond the batch is picked up by the next minute's run.

**Idempotency.** Safe to run twice, concurrently or back to back. Dispatch is guarded by the compare-and-swap above and the no-live-session precondition. Voiding and watchdog transitions follow the session state machine and are no-ops on a session or choice already in the target state. Terminal sessions are never touched.

**Retry behaviour.** No task-level retry is relied on. The next minute's run is the retry: a transient gateway failure deletes the row and re-arms the choice, and a failed watchdog step is re-evaluated from current state.

**Serves.** FR-007 (join request within one minute of start, SC-002), FR-008 (one notetaker per booking), FR-010 (backstop for the bot's own timers), FR-024 and SC-008 (a lost bot still ends in a recorded reason, no silent failure).

### `notetaker.finalize-session`

**Trigger.** Enqueued through `INotetakerTasker.finalizeSession` when a session reaches `PROCESSING` after admission: from `NotetakerSessionEventService` on `session.ended`, and from `NotetakerDispatchService` on post-admission heartbeat loss and on stop→404. It is never enqueued for pre-admission ends.

**Payload.**

| Field | Type | Null | Notes |
|---|---|---|---|
| sessionId | string | no | `NotetakerSession.id` |

**What `NotetakerFinalizeService` does.**

1. Load the session in `PROCESSING` with its transcript. The session carries a provisional `outcomeReason` written when it entered `PROCESSING` (the one-or-more-passages column of the outcome mapping in [../data-model.md](../data-model.md)). If the session is not `PROCESSING` (already `READY`, `ENDED_EARLY` or `FAILED`), return without changes.
2. Count the passage rows. `passageCount` is this count; `session.ended.passageCount` is only compared with it to log a mismatch.
3. If the count is zero, apply the zero-passage column of the outcome mapping: delete the transcript row so an empty transcript is never presented, and set the session `FAILED` with the `outcomeReason` that column gives (`NO_SPEECH_DETECTED` for a normal end).
4. Otherwise set the transcript language (duration-weighted passage language), `passageCount` and `durationMs`, and set completeness:
   1. End reason `MEETING_ENDED` or `ALONE_TIMEOUT`: transcript `COMPLETE`, session `READY`, no `outcomeReason`.
   2. End reason `LENGTH_LIMIT_REACHED`: transcript `TRUNCATED`, session `READY`, `outcomeReason` `LENGTH_LIMIT_REACHED`.
   3. Any other end reason: apply the outcome mapping table in [../data-model.md](../data-model.md) (section "Outcome mapping"), which also covers the normalised combinations. The bot's `endReason` from the accepted `session.ended` must be available to finalize so the zero-passage column can be applied correctly; for example, a post-admission `MEETING_DID_NOT_START` with zero passages ends `FAILED` / `MEETING_DID_NOT_START`, not `NO_SPEECH_DETECTED`. How it is carried (the provisional `outcomeReason` alone is not enough for that case) is an implementation detail to settle in the finalize PR.
   `durationMs` is `session.ended.durationMs` when that event was accepted, otherwise the maximum passage `endMs`.
5. On a watchdog interruption with `interruptedAtMs` still null, set it to the last passage's `endMs`, or 0. Set `endedAt` and, for `ENDED_EARLY` and `FAILED`, the final `outcomeReason`, replacing the provisional value.
6. Queue `notetaker.generate-summary` (`requestedByUserId: null`) when the result is `READY` or `ENDED_EARLY` and the word count is sufficient.
7. Queue `notetaker.send-notification` for the enabling hosts: kind `FAILED` for a zero-passage `FAILED` result, and kind `RESULTS_READY` when the summary is set `NOT_ENOUGH_CONTENT`. Otherwise `RESULTS_READY` is queued by `NotetakerSummaryService` when the first generation settles. Each uses the idempotency key `notetaker:<KIND>:<sessionId>`.

**Idempotency.** Safe to run twice. Step 1 makes a repeat a no-op once the session is terminal, and the outcome is derived only from stored session and passage data. A run that dies after the status write but before the queueing re-queues on retry only if the session is still `PROCESSING`, so the status write and the queueing happen in that order within one service call and the summary and notification tasks are themselves idempotent.

**Retry behaviour.** Retried with the shared task `retry` config (including `outOfMemory`); attempts to be sized. A session stays in `PROCESSING` until finalize succeeds.

**Serves.** FR-009, FR-017, FR-024, SC-004 (results available within 10 minutes of the meeting ending), SC-008 (specific reason recorded within 15 minutes of the scheduled end).

### `notetaker.generate-summary`

**Trigger.** Enqueued by `NotetakerFinalizeService` (`requestedByUserId: null`) when the result is `READY` or `ENDED_EARLY` and the word count is sufficient, and by `NotetakerSummaryService` on the host's `regenerateSummary` re-request (`requestedByUserId` set to the requesting host).

**Payload.**

| Field | Type | Null | Notes |
|---|---|---|---|
| transcriptId | string | no | `NotetakerTranscript.id` |
| requestedByUserId | number | yes | The host who asked for a re-request; null for the automatic run |

**What `NotetakerSummaryService.generate` does.**

1. Load the transcript and its summary row. If the summary is already `READY`, return without changes.
2. Create the summary row in `PENDING` if missing, or reset it to `PENDING` on a host re-request (the mutation upserts the row to `PENDING`, writes a `SUMMARY_REQUESTED` activity, enqueues this task, and returns the `NotetakerSummaryDto` with status `PENDING` immediately); increment `attempts`.
3. Load all passages in order and compute the word count. If fewer than `NOTETAKER_SUMMARY_MIN_WORDS` words, set status `NOT_ENOUGH_CONTENT` and stop, before any model call.
4. Call `INotetakerSummaryGenerator.generate({ passages, languageHint })` with the whole transcript in one request. The hint is the duration-weighted passage language; the summary is written in the predominant spoken language (FR-019).
5. Validate the result against `notetakerSummaryContentSchema` and store `language`, `overview`, `keyPoints`, `decisions`, `actionItems`, `model`, `generatedAt` with status `READY`.
6. On a model refusal (`stop_reason: "refusal"`) or a schema failure, set status `FAILED` with a `failureCode`. A summary failure never changes the session status.

**Idempotency.** Safe to run twice. A `READY` summary is not overwritten, and the result is stored in one update keyed by the one-to-one `transcriptId`. A host re-request is allowed only when the summary status is `FAILED`, or no summary row exists while a transcript does (FR-022). `PENDING`, `READY` and `NOT_ENOUGH_CONTENT` give BadRequest.

**Retry behaviour.** The task retries 3 times (`maxAttempts` 3 in the shared config), with the backoff and `outOfMemory` machine step-up in `trigger/config.ts`. After the last attempt the summary is left `FAILED` and the host can re-request.

**Serves.** FR-018, FR-019, FR-022, SC-004, and SC-006 (summary quality).

### `notetaker.send-notification`

**Trigger.** Enqueued through `INotetakerTasker.sendNotification` by the services listed in [Who enqueues what](#who-enqueues-what). The session-scoped kinds (`ADMIT_PROMPT`, `RESULTS_READY`, `FAILED`) are enqueued only on the winning status transition, with the Trigger idempotency key `notetaker:<KIND>:<sessionId>`. The kinds, recipients and templates are defined in [notifications.md](./notifications.md).

**Payload.**

| Field | Type | Null | Notes |
|---|---|---|---|
| kind | NotetakerNotificationKind | no | `ATTENDEE_NOTICE`, `ADMIT_PROMPT`, `RESULTS_READY`, `FAILED`, `TURNED_OFF` or `SHARED_WITH_ATTENDEES` |
| bookingId | number | no | `Booking.id` |
| sessionId | string | yes | `NotetakerSession.id`; null for kinds not tied to a session |

**What `NotetakerNotificationService.send` does.**

1. Resolve recipients for the kind: for host notices, the distinct users with an `ENABLED` activity on the booking, or the organizer when the choice was inherited (no user); for attendee kinds, the booking attendees.
2. For `ATTENDEE_NOTICE`, dedupe per attendee: the recipients are the current `Attendee.email` values minus the `notifiedAttendeeEmails` of this booking and of bookings sharing the same non-null `recurringEventId`. If none remain, return without sending. After sending, append the recipients to `notifiedAttendeeEmails` and set `attendeesNotifiedAt = now`. The dispatch sweep enqueues this kind as a catch-all, so attendees added after the notice are covered at dispatch.
3. Render the email in each recipient's locale and send it through the existing `packages/emails` pattern. For `ADMIT_PROMPT` also send the web push; the in-app banner is driven by status polling.
4. The link goes to `${WEBAPP_URL}/booking/{uid}/notetaker`. No notification contains transcript text (FR-020).

**Idempotency.** Safe to run twice for `ATTENDEE_NOTICE` through `notifiedAttendeeEmails`. The session-scoped kinds are sent once per session through the idempotency key `notetaker:<KIND>:<sessionId>`. For the other kinds a duplicate run can send a duplicate email; retries only happen when the run failed before completing.

**Retry behaviour.** Retried with the shared task `retry` config; attempts to be sized.

**Serves.** FR-014, FR-020, FR-024, FR-025, FR-027, SC-008.

## Tasker interface

Shape only; the exact payload types are `z.infer` of the schemas in `trigger/schema.ts`.

```ts
type NotetakerFinalizeSessionPayload = { sessionId: string };
type NotetakerGenerateSummaryPayload = { transcriptId: string; requestedByUserId: number | null };
type NotetakerSendNotificationPayload = {
  kind: NotetakerNotificationKind;
  bookingId: number;
  sessionId: string | null;
};

interface INotetakerTasker {
  finalizeSession(payload: NotetakerFinalizeSessionPayload, options?: TriggerOptions): Promise<{ runId: string }>;
  generateSummary(payload: NotetakerGenerateSummaryPayload, options?: TriggerOptions): Promise<{ runId: string }>;
  sendNotification(payload: NotetakerSendNotificationPayload, options?: TriggerOptions): Promise<{ runId: string }>;
}
```

`notetaker.dispatch-due-sessions` has no payload and no method on the interface; it is only started by its cron schedule (or by the cron route in the synchronous fallback).

Classes, following `packages/features/calendars/lib/tasker/`:

- `NotetakerTasker`: subclass of `Tasker<INotetakerTasker>` from `@calcom/lib/tasker/Tasker`; the entry point callers use, dispatching to the async or the sync implementation.
- `NotetakerTriggerTasker`: async implementation; triggers the Trigger.dev tasks and returns the `runId`.
- `NotetakerSyncTasker`: synchronous fallback; runs the same work inline.
- `NotetakerTaskService`: the business logic both taskers call, delegating to `NotetakerFinalizeService`, `NotetakerSummaryService` and `NotetakerNotificationService`.

## Synchronous fallback

- When `ENABLE_ASYNC_TASKER` is off or the Trigger.dev env is not configured, the base `Tasker` falls back to `NotetakerSyncTasker`, which runs finalize, summary generation and notification inline in the calling request or event handler and returns a placeholder run id.
- A `schedules.task` cannot run without Trigger.dev, so the scheduled sweep is driven by the cron route `apps/web/app/api/cron/notetaker/route.ts`, which calls the same `NotetakerDispatchService.dispatchDue()`. Self-hosters call it every minute from any scheduler.
- The route handles `GET` and is wrapped in `defaultResponderForAppDir`. It is authorized when the `authorization` header or the `apiKey` query parameter equals `CRON_API_KEY` or `Bearer ${CRON_SECRET}`; anything else gets 401. It returns `{ ok: true }`. It follows `apps/web/app/api/cron/calendar-subscriptions/route.ts`.
- Behaviour is otherwise identical: the same services, the same compare-and-swap and the same state machine.

## Configuration

Read in `packages/features/notetaker/lib/config.ts`; every variable must be added to `turbo.json` `globalEnv` and `.env.example`.

| Variable | Default | Effect on tasks |
|---|---|---|
| `NOTETAKER_JOIN_LEAD_SECONDS` | 120 | `dispatch-due-sessions` dispatches bookings starting within this many seconds |
| `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS` | 180 | Watchdog treats a session with no event for this long, since the later of `dispatchedAt` and `lastHeartbeatAt`, as interrupted |
| `NOTETAKER_SUMMARY_MIN_WORDS` | 40 | `generate-summary` sets `NOT_ENOUGH_CONTENT` below this word count, before any model call |
| `NOTETAKER_SUMMARY_MODEL` | `claude-opus-5-5` | Model used by `AnthropicSummaryGenerator` (an operator can choose a cheaper tier) |

Related variables that affect tasks indirectly: `ENABLE_ASYNC_TASKER`, the Trigger.dev env (`TRIGGER_SECRET_KEY`, `TRIGGER_API_URL`), `NOTETAKER_ENABLED_PLATFORMS` (eligibility in the sweep), `ANTHROPIC_API_KEY` (summary), and the cron key for the cron route.

Sizing, per `agents/rules/patterns-trigger-dev.md`: queue `concurrencyLimit`, machine size and retry numbers are to be set from measured production volume before merge, starting from the smallest machine and a conservative concurrency, and `retry` must include `outOfMemory` with a larger machine.

| Setting | Design value |
|---|---|
| Queue name | `notetaker` |
| Queue `concurrencyLimit` | to be sized |
| Machine | to be sized (start with the smallest) |
| Retry, `notetaker.generate-summary` | `maxAttempts` 3; backoff to be sized |
| Retry, other tasks | to be sized |
| `outOfMemory` machine | to be sized (larger than the default machine) |
| Sweep batch | 200 per run |
| Task duration cap | 600 seconds (global `maxDuration`) |
