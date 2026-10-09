# Contract: Public API and Webhooks

Feature spec: [../spec.md](../spec.md)

## Decision for this version

Version 1 adds no API v2 endpoint, no webhook trigger event and no field to any existing payload. `docs/api-reference/v2/openapi.json` does not change.

Additive-only changes (FR-033, constitution Principle IV) are easiest to guarantee by adding nothing. A new webhook trigger would touch several packages, because API v2 handles the trigger enum exhaustively, so it deserves its own specification rather than riding along with this one.

## What stays unchanged

- The existing booking transcripts endpoint (`GET /v2/bookings/:bookingUid/transcripts`, version `2024-08-13`, in the API v2 bookings controller), which serves built-in video transcripts only.
- The existing `RECORDING_TRANSCRIPTION_GENERATED` webhook trigger and its meaning: a built-in video transcription is ready.
- Booking payloads, in API v2, API v1 and webhooks. No field is added, renamed or removed.
- Built-in video transcription behaviour, including the `apps/web/app/api/recorded-daily-video/route.ts` flow (FR-032). The notetaker is not offered for those meetings.

## Internal machine endpoints (not public API)

| Endpoint | Authentication | Caller | Contract |
|---|---|---|---|
| `POST /api/notetaker/events` | HMAC signature | The notetaker bot service | [bot-events-webhook.md](bot-events-webhook.md) |
| `GET /api/cron/notetaker` | `CRON_API_KEY`, or `Bearer ${CRON_SECRET}`, in the `authorization` header or the `apiKey` query parameter; anything else gets 401 | The scheduler, through a cron entry in `apps/web/vercel.json` that this feature adds | [tasker.md](tasker.md) |

These endpoints carry no stability guarantee for third parties. They are not documented in the OpenAPI document and may change together with the bot service and the scheduler.

## Deferred follow-ups

Candidates for a later specification, not commitments:

- A webhook trigger for "transcript ready" (working name `NOTETAKER_TRANSCRIPT_READY`).
- A date-versioned read endpoint for a booking's notetaker transcript (working name `GET /v2/bookings/:uid/transcript`).

Either would follow Principle IV: new date-versioned endpoint, optional fields only, previous behaviour kept.

## Verification

- `git diff` shows no change to `docs/api-reference/v2/openapi.json`.
- Existing webhook tests, including those for `RECORDING_TRANSCRIPTION_GENERATED`, pass without modification (SC-011).
