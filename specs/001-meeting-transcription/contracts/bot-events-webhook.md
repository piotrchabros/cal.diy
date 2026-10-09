# Contract: Bot Events (bot → app)

Related: [../spec.md](../spec.md), [../data-model.md](../data-model.md) and, for the reverse direction (app → bot), [bot-control-api.md](./bot-control-api.md).

Events sent by the bot service (`apps/notetaker-bot`) to the web application while it is in a meeting: status changes, heartbeats and batches of transcript passages. Streaming passages as they are produced means a bot crash still leaves the content captured so far (FR-011).

## Endpoint

`POST {WEBAPP_URL}/api/notetaker/events`

Implemented at `apps/web/app/api/notetaker/events/route.ts`.

This is a machine endpoint between the two deployables of the feature. It is not part of the public API: it is not documented in the API v2 OpenAPI spec, adds no webhook trigger and no payload field, and is not meant to be called by anything other than the bot.

## Authentication

The same HMAC scheme as the control API ([bot-control-api.md](./bot-control-api.md)).

| Item | Value |
|---|---|
| Header `X-Notetaker-Timestamp` | The time the request was signed, as Unix epoch seconds in a decimal string |
| Header `X-Notetaker-Signature` | `sha256=<hex>` |
| Algorithm | HMAC-SHA256 |
| Secret | `NOTETAKER_BOT_SECRET`, shared by the app and the bot |
| Signed string | `<timestamp>.<rawBody>` (the raw request body, not a re-serialised one) |
| Tolerance | ±300 seconds between the timestamp and the receiver's clock |

A bad signature or a timestamp outside ±300 seconds is answered with `401`. The HMAC helpers live in `packages/lib/notetaker/botContract.ts`, shared by both sides together with the Zod schemas. The types `NotetakerBotEvent` (the union of the seven envelopes below) and `NotetakerBotEndReason` (the `endReason` values) are inferred from those Zod schemas.

## Envelope

Every request body is a single event:

| Field | Type | Rules |
|---|---|---|
| `eventId` | string (uuid) | Unique per event. The idempotency key; a retry of the same event reuses it |
| `sessionId` | string | The `NotetakerSession.id` given to the bot in the join request |
| `sequence` | number | Integer, `≥ 1`, strictly increasing within a session |
| `occurredAt` | string | When the event happened in the bot; ISO 8601 UTC with milliseconds and a `Z` suffix, e.g. `2030-01-01T10:00:05.000Z` |
| `type` | string | One of the seven event types below |
| `data` | object | Shape depends on `type` |

A body that does not match the schema for its `type` is rejected with `400` (see [Validation limits](#validation-limits)).

## Event types

Seven types. Every accepted event also sets `lastEventSequence` to its `sequence`.

### `session.join_requested`

`data`: `{}`

Sent when the bot has asked the meeting platform for entry and is waiting to be admitted.

Effect: `SCHEDULED` → `WAITING_TO_BE_ADMITTED`. Sets `joinRequestedAt`.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000001",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 1,
  "occurredAt": "2030-01-01T10:00:05.000Z",
  "type": "session.join_requested",
  "data": {}
}
```

### `session.admitted`

`data`: `{}`

Sent when the bot is let into the meeting.

Effect: `SCHEDULED` or `WAITING_TO_BE_ADMITTED` → `TRANSCRIBING`. Sets `admittedAt`.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000002",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 2,
  "occurredAt": "2030-01-01T10:01:10.000Z",
  "type": "session.admitted",
  "data": {}
}
```

### `session.notice_posted`

`data`: `{}`

Sent when the bot has posted the recording notice (the `noticeMessage` from the join request) in the meeting chat.

Effect: no status change. Sets `noticePostedAt`.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000003",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 3,
  "occurredAt": "2030-01-01T10:01:12.000Z",
  "type": "session.notice_posted",
  "data": {}
}
```

### `session.heartbeat`

`data`: `{ participantCount: number }`

Sent every 30 seconds for as long as the bot is running a session. See [Liveness](#liveness).

Effect: no status change. Sets `lastHeartbeatAt`.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000004",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 4,
  "occurredAt": "2030-01-01T10:01:40.000Z",
  "type": "session.heartbeat",
  "data": { "participantCount": 3 }
}
```

### `session.reconnecting`

`data`: `{ atMs: number }`

Sent once, when the bot loses the meeting after admission and starts its single rejoin attempt. `atMs` is the position at which the connection was lost, on the same clock as passage `startMs`: milliseconds since transcription started at admission.

Effect: no status change. Sets `rejoinAttempted = true` and `interruptedAtMs = atMs`. `session.ended.interruptedAtMs` later overwrites that field: `null` when the rejoin succeeded, and the same value when `endReason` is `INTERRUPTED`. On a watchdog interruption with the field still `null`, finalize sets it to the `endMs` of the last passage, or `0`.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000005",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 12,
  "occurredAt": "2030-01-01T10:20:00.000Z",
  "type": "session.reconnecting",
  "data": { "atMs": 1130000 }
}
```

### `transcript.passages`

`data`: `{ passages: { index, speakerKey, speakerName: string | null, unknownSpeakerNumber: number | null, startMs, endMs, text, language: string | null }[] }`

Sent as passages are produced, batched. At most 50 passages per event; see [Validation limits](#validation-limits).

Effect: no status change. Creates the `NotetakerTranscript` on the first such event (completeness `PARTIAL`, which is correct if the bot dies before finalize) and inserts the passages keyed `(transcriptId, index)` with `createMany` and `skipDuplicates`, so a replay never duplicates a passage.

Passage field rules (FR-009):

| Field | Type | Rules |
|---|---|---|
| `index` | number | Position of the passage in the transcript; with the transcript, the passage's primary key. Display order is by `index` |
| `speakerKey` | string | Stable key for the speaker within the session |
| `speakerName` | string or null | The participant's name when identified |
| `unknownSpeakerNumber` | number or null | The numbered "unknown speaker" label when the speaker is not identified |
| `startMs` | number | Start of the passage, milliseconds from the start of the transcript timeline |
| `endMs` | number | `endMs ≥ startMs` |
| `text` | string | Non-empty, at most 1,000 characters |
| `language` | string or null | Language tag when the speech provider supplies one |

- Exactly one of `speakerName` / `unknownSpeakerNumber` is non-null. A name is never guessed: an unresolved speaker is an unknown speaker with a number.
- The 60-second passage cap is a bot-side rule only. The app does not validate it; it enforces only the limits in [Validation limits](#validation-limits).

```json
{
  "eventId": "00000000-0000-4000-8000-000000000006",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 5,
  "occurredAt": "2030-01-01T10:02:00.000Z",
  "type": "transcript.passages",
  "data": {
    "passages": [
      {
        "index": 0,
        "speakerKey": "speaker-1",
        "speakerName": "Example Person",
        "unknownSpeakerNumber": null,
        "startMs": 1000,
        "endMs": 6500,
        "text": "Example passage text.",
        "language": "en"
      },
      {
        "index": 1,
        "speakerKey": "speaker-2",
        "speakerName": null,
        "unknownSpeakerNumber": 1,
        "startMs": 6800,
        "endMs": 9200,
        "text": "Another example passage.",
        "language": "en"
      }
    ]
  }
}
```

### `session.ended`

`data`: `{ endReason, durationMs: number, interruptedAtMs: number | null, passageCount: number }`

`endReason` is one of `MEETING_ENDED`, `ALONE_TIMEOUT`, `NOT_ADMITTED`, `MEETING_DID_NOT_START`, `REMOVED_BY_PARTICIPANT`, `STOP_REQUESTED`, `INTERRUPTED`, `LENGTH_LIMIT_REACHED`, `MEETING_LINK_UNUSABLE`. `durationMs` is the time spent in the meeting, `interruptedAtMs` the position at which content stops when the session was interrupted (otherwise `null`) and `passageCount` the number of passages the bot sent. `passageCount` is advisory: the app uses it only to log a mismatch, and takes the count of stored rows at finalize as authoritative. `durationMs` from this event is authoritative when the event is accepted; otherwise the maximum passage `endMs` is used.

The bot sends it once, as its last event, whenever it leaves or gives up (FR-010): the meeting ended, it was alone for the alone timeout, it was removed or stopped, it was not admitted in time, nobody joined by the no-show timeout, the maximum duration was reached, or the link could not be used.

Effect: the session leaves its current state according to the table in [End reasons](#end-reasons). After admission it moves to `PROCESSING` with a provisional `outcomeReason` (the one-or-more-passages column), and the finalize step (`notetaker.finalize-session`) counts the stored passages and applies the zero-passage column when the count is zero. Before admission it goes directly to its final status. Sets `endedAt`, and `interruptedAtMs` when given.

```json
{
  "eventId": "00000000-0000-4000-8000-000000000007",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sequence": 40,
  "occurredAt": "2030-01-01T10:45:00.000Z",
  "type": "session.ended",
  "data": {
    "endReason": "MEETING_ENDED",
    "durationMs": 2630000,
    "interruptedAtMs": null,
    "passageCount": 312
  }
}
```

## End reasons

How each `endReason` of `session.ended` is resolved. `endReason` is a wire value and not the same set as `NotetakerOutcomeReason`: `MEETING_ENDED`, `ALONE_TIMEOUT` and `STOP_REQUESTED` are not outcome reasons. Where the same name exists in both sets it maps to itself.

"Before admission" means `admittedAt` is null. A schema-valid `session.ended` is never rejected for an unexpected combination: the app normalises it as shown below and logs a warning. Cells are session status / `outcomeReason` / transcript completeness.

| `endReason` | Before admission | After admission, 1 or more passages | After admission, 0 passages |
|---|---|---|---|
| `MEETING_ENDED` | `FAILED` / `NOT_ADMITTED` | `READY` / null / `COMPLETE` | `FAILED` / `NO_SPEECH_DETECTED` |
| `ALONE_TIMEOUT` | `FAILED` / `MEETING_DID_NOT_START` (normalised) | `READY` / null / `COMPLETE` | `FAILED` / `NO_SPEECH_DETECTED` |
| `NOT_ADMITTED` | `FAILED` / `NOT_ADMITTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` (normalised) | `FAILED` / `INTERRUPTED` (normalised) |
| `MEETING_DID_NOT_START` | `FAILED` / `MEETING_DID_NOT_START` | `READY` / null / `COMPLETE` (normalised) | `FAILED` / `MEETING_DID_NOT_START` |
| `REMOVED_BY_PARTICIPANT` | `FAILED` / `REMOVED_BY_PARTICIPANT` | `ENDED_EARLY` / `REMOVED_BY_PARTICIPANT` / `PARTIAL` | `FAILED` / `REMOVED_BY_PARTICIPANT` |
| `STOP_REQUESTED` | Row deleted if it still exists; respond `200`; no notice | `ENDED_EARLY` / `STOPPED_BY_HOST` / `PARTIAL` | `FAILED` / `STOPPED_BY_HOST` |
| `INTERRUPTED` | `FAILED` / `INTERRUPTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` | `FAILED` / `INTERRUPTED` |
| `LENGTH_LIMIT_REACHED` | `FAILED` / `INTERRUPTED` (normalised) | `READY` / `LENGTH_LIMIT_REACHED` / `TRUNCATED` | `FAILED` / `NO_SPEECH_DETECTED` |
| `MEETING_LINK_UNUSABLE` | `FAILED` / `MEETING_LINK_UNUSABLE` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` (normalised) | `FAILED` / `INTERRUPTED` (normalised) |
| Watchdog heartbeat loss (no `session.ended`) | `FAILED` / `INTERRUPTED` | `ENDED_EARLY` / `INTERRUPTED` / `PARTIAL` | `FAILED` / `INTERRUPTED` |

Terminal statuses are `READY`, `ENDED_EARLY` and `FAILED`.

- Every `FAILED` has no transcript. A transcript with zero passages is deleted at finalize, so an empty transcript is never presented. Content captured before an interruption is always kept and labelled partial with the reason (FR-011).
- Mechanism, with no new field: on a `session.ended` after admission the event service sets the status to `PROCESSING` and writes a provisional `outcomeReason` (the one-or-more-passages column). Finalize counts the passage rows and applies the zero-passage column when the count is zero.
- `rejoinBlocked` is set on the booking's notetaker choice for `REMOVED_BY_PARTICIPANT` in any phase and for `STOP_REQUESTED` after admission, so the bot does not rejoin the meeting (FR-015). It is not set for a pre-admission disable.
- A host disabling the notetaker, or the booking no longer being `ACCEPTED`, before admission deletes the session row and no transcript or notice results (US1.4). The bot's later events for that session get `410`.

## Responses

| Status | Meaning | What the bot must do |
|---|---|---|
| `200` `{ ok: true }` | Event accepted. Also returned for a retried duplicate of an accepted event (same `eventId`, or `sequence` at or below `lastEventSequence`), which is ignored | Treat as delivered and send the next event |
| `401` | Bad signature or a timestamp outside ±300 seconds | Do not retry the same request unchanged; fix the signing or the clock |
| `400` | Schema failure, including a [validation limit](#validation-limits) violation | Do not retry the same payload; it will keep failing |
| `410` | Unknown session (including a deleted row), or a session in `PROCESSING` or a terminal status | Final: leave the meeting now, stop sending events for this session and do not retry (the kill switch). Nothing is changed in the app |
| `5xx` | App-side failure | Retry with backoff, preserving order: do not send a later `sequence` before this one is accepted |

## Ordering and idempotency

- `eventId` is the idempotency key; replaying an accepted event gets `200` and changes nothing.
- `sequence` is strictly increasing per session, starting at `1`. The bot sends events in order and, on a `5xx`, retries the same event with backoff rather than skipping ahead.
- The app stores `lastEventSequence` on the session. An event with `sequence ≤ lastEventSequence` is acknowledged with `200` and ignored, so no duplicate passages are written.
- Order of checks: signature, then schema, then session lookup (an unknown session gets `410`), then `sequence ≤ lastEventSequence` (`200`, ignored), then status (`PROCESSING` or terminal gets `410` with nothing changed).
- So a late `session.ended` or late passages after the watchdog moved the session, or after finalize, get `410`: the first end wins and the bot leaves. A retried duplicate of an already-accepted `session.ended` gets `200` through the sequence check.
- A `session.ended` for a deleted row (for example after a pre-admission disable) gets `410`.

## Validation limits

The app enforces only the schema: `text` is 1 to 1,000 characters, `endMs ≥ startMs`, and at most 50 passages per `transcript.passages` event. A violation is answered with `400`. The 60-second passage cap is a bot-side rule and is not validated by the app.

## Liveness

The bot sends `session.heartbeat` every 30 seconds. The app-side watchdog, part of the `notetaker.dispatch-due-sessions` sweep, measures the time since the later of `dispatchedAt` and `lastHeartbeatAt` against `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS` (default 180). When no event has arrived within that time, the watchdog also calls `requestStop` on the bot, best-effort, and then:

- a session after admission moves to `PROCESSING` and finalizes as interrupted (`INTERRUPTED`; `ENDED_EARLY` with a partial transcript when passages exist, otherwise `FAILED`), as in the last row of the [End reasons](#end-reasons) table;
- a session that was still `SCHEDULED` or `WAITING_TO_BE_ADMITTED` is marked `FAILED` with `INTERRUPTED`.

The watchdog is the backstop for a bot that dies without sending `session.ended`. The in-room timers (admission, no-show, alone, maximum duration) belong to the bot, which receives the limits in each join request.

## Data handling

Events carry text only: status, counts and transcript passages. No audio or video is ever sent to the app, written to disk by the bot or stored; the bot forwards audio frames to the speech-to-text provider and discards them (FR-030).
