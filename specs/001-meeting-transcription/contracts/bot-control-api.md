# Contract: Bot Control API (app → bot)

Spec: [../spec.md](../spec.md) · Data model: [../data-model.md](../data-model.md) · Reverse direction (bot → app): [bot-events-webhook.md](./bot-events-webhook.md)

## Scope

The bot service is `apps/notetaker-bot` (package `@calcom/notetaker-bot`), a standalone Node/TS service with its own Dockerfile. It joins the meeting, transcribes it and leaves. One meeting runs per runner container; a small controller HTTP server receives the requests below and launches runners through a `MeetingRunnerLauncher` interface.

The bot has no database access. It imports no `@calcom/features`, `@calcom/trpc` or `@calcom/prisma`. The only code it shares with the app is the wire schemas (Zod schemas plus HMAC helpers) in `packages/lib/notetaker/botContract.ts`.

The app talks to the bot only through `INotetakerBotGateway`. `NotetakerBotGatewayFactory` picks the implementation, so another provider can be substituted without touching the app's services (see [Gateway interface](#gateway-interface)).

This document covers requests from the app to the bot. Status events and transcript passages flowing from the bot to the app are in [bot-events-webhook.md](./bot-events-webhook.md).

## Authentication

Base URL: `NOTETAKER_BOT_URL`.

Every request carries two headers:

| Header | Value |
|---|---|
| `X-Notetaker-Timestamp` | The time the request was signed: Unix epoch seconds as a decimal string, for example `1893492000` |
| `X-Notetaker-Signature` | `sha256=<hex>` |

The signature is HMAC-SHA256 with the shared secret `NOTETAKER_BOT_SECRET` over the string `<timestamp>.<rawBody>`, where `timestamp` is the value of `X-Notetaker-Timestamp` and `rawBody` is the request body exactly as sent. For a `GET` request the body is empty, so the signed string is `<timestamp>.`. The receiver accepts a timestamp within ±300 seconds of its own clock.

The same scheme, secret and tolerance protect the bot → app direction.

On failure (missing or malformed header, signature mismatch, timestamp outside the tolerance) the receiver rejects the request and does not act on it. The bot answers `401` with:

```json
{ "error": "invalid_signature" }
```

## Endpoints

### `POST /v1/sessions`

Asks the bot to join a meeting and transcribe it.

Request body:

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The app's `NotetakerSession.id`; the idempotency key |
| `platform` | `"GOOGLE_MEET" \| "MICROSOFT_TEAMS"` | Meeting platform |
| `meetingUrl` | `string` | The meeting link resolved at dispatch time |
| `displayName` | `string` | Name the bot asks to join under. Applied where the platform lets a participant choose its name (guest joins). In Google Meet account mode the platform shows the bot account's own name and this field is not applied |
| `noticeMessage` | `string` | Message the bot posts when it begins transcribing |
| `scheduledStartAt` | `string` | Scheduled start of the meeting (ISO 8601 UTC with milliseconds and a `Z` suffix) |
| `callbackUrl` | `string` | URL the bot posts events to (`{WEBAPP_URL}/api/notetaker/events`) |
| `limits.admissionTimeoutSeconds` | `number` | Leave if not admitted within this time (default 600) |
| `limits.noShowTimeoutSeconds` | `number` | Leave if no one else joins within this time of the scheduled start (default 900) |
| `limits.aloneTimeoutSeconds` | `number` | Leave if the bot is the only participant for this long (default 120) |
| `limits.maxDurationSeconds` | `number` | Leave after this much meeting time (default 14400) |

The limit defaults come from `NOTETAKER_ADMISSION_TIMEOUT_SECONDS`, `NOTETAKER_NO_SHOW_TIMEOUT_SECONDS`, `NOTETAKER_ALONE_TIMEOUT_SECONDS` and `NOTETAKER_MAX_DURATION_SECONDS`, read by the app and sent per session.

Responses:

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ sessionId, externalRef: string }` | Accepted |
| `422` | | The meeting URL is unusable |
| `503` | | The bot is at capacity |

Idempotency and retry: idempotent on `sessionId`; a repeat request returns the same body. After a `503`, a timeout, a network error or a `5xx` the app deletes the session row and sets `pendingDispatch = true`, so the next sweep retries the call (see [Failure handling](#failure-handling)).

Example request:

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "platform": "GOOGLE_MEET",
  "meetingUrl": "https://meet.example.test/abc-defg-hij",
  "displayName": "Example Notetaker for Jane Host",
  "noticeMessage": "This meeting is being transcribed by an automated notetaker on behalf of Jane Host. Remove the notetaker to stop transcription.",
  "scheduledStartAt": "2030-01-01T10:00:00.000Z",
  "callbackUrl": "https://app.example.test/api/notetaker/events",
  "limits": {
    "admissionTimeoutSeconds": 600,
    "noShowTimeoutSeconds": 900,
    "aloneTimeoutSeconds": 120,
    "maxDurationSeconds": 14400
  }
}
```

Example response (`202`):

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "externalRef": "fake-ref-0001"
}
```

### `POST /v1/sessions/:sessionId/stop`

Asks the bot to leave a meeting and stop transcribing.

Request body:

| Field | Type | Meaning |
|---|---|---|
| `reason` | `"STOPPED_BY_HOST" \| "BOOKING_NOT_ACTIVE" \| "DISABLED"` | Why the app is stopping the session |

Responses:

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ sessionId: string, accepted: true }` | Accepted; the bot leaves within 10 seconds |
| `404` | | Unknown `sessionId` |

Idempotency and retry: idempotent on `sessionId`; a repeat request returns the same `202`. A session that has already ended also gets `202`.

A `404` is not an error for the caller: `requestStop` resolves without throwing, and the app applies the watchdog path immediately. Before admission the session row is already deleted. After admission the session goes to `PROCESSING` with a provisional `outcomeReason` of `STOPPED_BY_HOST`, and `finalize-session` is enqueued.

Example request:

```json
{
  "reason": "STOPPED_BY_HOST"
}
```

Example response (`202`):

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "accepted": true
}
```

### `GET /v1/sessions/:sessionId`

Returns the bot's view of a session.

Request body: none.

Responses:

| Status | Body |
|---|---|
| `200` | `{ sessionId, phase: "STARTING" \| "WAITING" \| "IN_MEETING" \| "ENDED", lastEventSequence: number }` |
| `404` | none |

An unknown `sessionId` returns `404`, and the gateway's `getState` then returns `null`.

Example response (`200`):

```json
{
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "phase": "IN_MEETING",
  "lastEventSequence": 7
}
```

### `GET /healthz`

Liveness and capacity probe.

Request body: none. This endpoint is unsigned and exposes no session data.

Responses:

| Status | Body |
|---|---|
| `200` | `{ ok: true, activeSessions: number, capacity: number }` |

Example response (`200`):

```json
{
  "ok": true,
  "activeSessions": 2,
  "capacity": 10
}
```

## Bot behaviour required by a join request

- Joins under `displayName` where the platform lets it choose its name; that name identifies it as an automated notetaker and names the host or organization it acts for. In Google Meet account mode it joins under the name of its Google account, does not try to change it, and logs once per session that `displayName` was not applied; the operator sets that account's name so that it identifies an automated notetaker and the operating organization, and `noticeMessage` names the host (FR-012, FR-013).
- Posts `noticeMessage`, visible to all participants, when it begins transcribing (FR-013).
- Enforces the four limits it was sent in `limits` (FR-010). The bot owns these in-room timers because only it sees the room; the app's watchdog is the backstop. The remaining FR-010 triggers (the meeting ends, the bot is removed or stopped) are the bot's too.
- Never speaks, shares content or acts in the meeting beyond joining, posting its notice and leaving (FR-016).
- Leaves within 10 seconds of a stop request and never rejoins that meeting after one (FR-015). Removal by a participant also ends transcription (FR-015).
- Retains no audio or video after the transcript has been produced (FR-030).
- Joins at most once per `sessionId`: a repeated `POST /v1/sessions` returns the same body and does not start a second bot. This idempotency on `sessionId` is the bot-side half of FR-008; one session per booking is guaranteed app-side by the compare-and-swap described in [tasker.md](./tasker.md).

## What the app does before a join request on Google Meet

When `NOTETAKER_GOOGLE_ACCOUNT_EMAIL` is set on the app, the provider is `self_hosted` and the platform is `GOOGLE_MEET`, the app adds that address to the guest list of the booking's Google Calendar event immediately before it sends the join request, so that a bot signed in to that account is let in without being admitted. It does so only when the event's own conference link is the `meetingUrl` of the request. It reads the event, appends one guest and sends no notification; it writes no attendee to the booking. The step can never fail or delay the join request by more than 8 seconds: on any other outcome the request is sent as usual, the bot asks to join, and the host is prompted to admit it (FR-025). The bot is not told the outcome and needs no change. The app does not know the bot's join mode; the variable being set is the operator's statement that the bot runs in account mode. The guest entry is not removed afterwards.

## Gateway interface

```ts
interface INotetakerBotGateway {
  requestJoin(input: NotetakerBotJoinRequest): Promise<{ externalRef: string }>;
  requestStop(input: { sessionId: string; reason: NotetakerBotStopReason }): Promise<void>;
  getState(sessionId: string): Promise<NotetakerBotStateDto | null>;
}
```

`NotetakerBotJoinRequest`, `NotetakerBotStopReason` (`"STOPPED_BY_HOST" | "BOOKING_NOT_ACTIVE" | "DISABLED"`) and `NotetakerBotStateDto` mirror the request and response bodies above. All three are inferred from the Zod schemas in `packages/lib/notetaker/botContract.ts`.

`NotetakerBotGatewayFactory` selects the implementation from `NOTETAKER_BOT_PROVIDER`:

| Value | Selects |
|---|---|
| `self_hosted` | `SelfHostedBotGateway`, which calls the bot service in this document; enum `NotetakerBotProvider.SELF_HOSTED` |
| `fake` | `FakeBotGateway`, which emits a scripted event sequence through `NotetakerSessionEventService`; enum `NotetakerBotProvider.FAKE` |
| `recall` | `RecallBotGateway`, not built in v1; enum `NotetakerBotProvider.RECALL`. It would add one webhook route translating Recall events into the same `NotetakerBotEvent` and nothing else |

Values are matched exactly, in lowercase. When `NOTETAKER_BOT_PROVIDER` is unset and `NODE_ENV !== "production"`, it means `fake`.

In production the feature reports disabled (`featureEnabled = false`, reason `FEATURE_DISABLED`) when the variable is unset, when it is `fake` without `NEXT_PUBLIC_IS_E2E` set, or when it is `recall`. The dispatch sweep then does nothing and logs an error.

## Failure handling

- The session row is created (`SCHEDULED`) before the gateway call. The request timeout is 10 seconds.
- `422` (unusable URL): the session becomes `FAILED` with `outcomeReason = MEETING_LINK_UNUSABLE` and `endedAt = now`, and a `FAILED` notice is sent.
- Timeout, network error, `5xx` or `503` (at capacity): the session row is deleted and `pendingDispatch = true`, so the next sweep (`notetaker.dispatch-due-sessions`, every minute) retries the call.
- Give-up: at `min(booking.endTime, max(startTime, setAt) + NOTETAKER_NO_SHOW_TIMEOUT_SECONDS)` a still-armed choice gets a `FAILED` session with `outcomeReason = INTERRUPTED`, `pendingDispatch = false`, and a `FAILED` notice.
- `404` on stop: the bot does not know the session; `requestStop` resolves and the app applies the watchdog path (see [Stop](#post-v1sessionssessionidstop)).
- A dispatch that the bot accepted but that later goes silent is handled by the heartbeat watchdog, which marks the session `INTERRUPTED` (see the session state machine in [../data-model.md](../data-model.md)).
