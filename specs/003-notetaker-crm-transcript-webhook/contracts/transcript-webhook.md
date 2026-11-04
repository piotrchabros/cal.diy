# Contract: notetaker transcript webhook (cal.diy to CRM)

**Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md) | **Version**: 2 (2026-11-06; version 1 of 2026-11-04 is a strict subset)

Both sides (this repo and Open Mercato `@open-mercato/webhook-calcom`) MUST match this contract exactly.

## Trigger and delivery

- Trigger: `RECORDING_TRANSCRIPTION_GENERATED` (existing enum value), sent through the existing webhook signing and delivery code to subscriptions that selected the trigger.
- Method and body: `POST`, JSON, the standard envelope `{ "triggerEvent", "createdAt", "payload" }`.
- Headers (as for every cal.diy webhook): `Content-Type: application/json`, `X-Cal-Signature-256` (lowercase hex HMAC-SHA256 of the raw body with the subscription secret; the literal `no-secret-provided` when the subscription has no secret, which the CRM rejects), `X-Cal-Webhook-Version: 2021-10-20`.
- Custom payload templates and Zapier subscriptions MUST NOT be used; they replace the body and drop the `notetaker` block.

## Body

`payload` takes one of two shapes depending on whether the booking has an event type. Both carry `source` and the same `notetaker` block.

### Booking with an event type (`source` = `"booking"`)

The normal booking webhook payload for that booking (`uid`, `title`, `startTime`, `endTime`, `organizer`, `attendees`, `location`, `metadata`, `bookingId`, `eventTypeId`, `status`, ...) plus `"source": "booking"` and the `notetaker` block.

### Booking without an event type (`source` = `"ad_hoc"` or `"calendar_auto_join"`)

Ad-hoc meetings (host pasted a link) and calendar auto-join meetings have no event type and no cal.diy attendees. They are sent as a *meeting payload*:

```json
{
  "type": "notetaker_meeting",
  "uid": "booking uid",
  "bookingId": 123,
  "eventTypeId": null,
  "status": "ACCEPTED",
  "title": "Customer call",
  "startTime": "2026-11-04T10:00:00.000Z",
  "endTime": "2026-11-04T10:30:00.000Z",
  "organizer": { "name": "Olivia Owner", "email": "owner@example.com", "timeZone": "Europe/Warsaw", "language": { "locale": "pl" } },
  "attendees": [
    { "name": "Casey Customer", "email": "customer@client.example", "timeZone": "Europe/Warsaw", "language": { "locale": "pl" } }
  ],
  "location": "https://meet.google.com/abc-defg-hij",
  "metadata": { "videoCallUrl": "https://meet.google.com/abc-defg-hij" },
  "source": "ad_hoc",
  "notetaker": { ... }
}
```

Rules:

- `organizer` is the booking owner (the host). `name` falls back to the email when the user has no name; `language.locale` falls back to `"en"`.
- `attendees` are the booking's meeting contacts (`specs/004`: manual customer emails and calendar invitees), in insertion order, each with the owner's time zone and locale, `name` `""` when unknown. The array MAY be empty.
- `location` and `metadata.videoCallUrl` are the booking's location, else the session's meeting URL; `metadata` is omitted when neither is known. No `utcOffset`, `eventTitle`, `responses` or other fields of the regular payload are present.
- `source` is `"calendar_auto_join"` when the booking carries the calendar-meeting marker, otherwise `"ad_hoc"`.

### `source` (all shapes)

`"booking" | "ad_hoc" | "calendar_auto_join"`. Optional for receivers (older senders omit it; the CRM defaults a missing value to `booking`). Also set on no other trigger than this one today.

### `notetaker` block (all shapes)

```json
"notetaker": {
  "version": 1,
  "sessionId": "uuid",
  "transcriptId": "uuid",
  "language": "en" | null,
  "completeness": "COMPLETE" | "PARTIAL" | "TRUNCATED",
  "durationMs": 3600000,
  "speakerNamesAvailable": true | false | null,
  "passages": [
    { "index": 0, "speakerKey": "s1", "speakerName": "Anna" | null, "unknownSpeakerNumber": 1 | null, "startMs": 0, "endMs": 4200, "text": "..." }
  ],
  "summary": null | {
    "status": "READY" | "FAILED",
    "language": "en" | null,
    "overview": "..." | null,
    "keyPoints": [ ... ], "decisions": [ ... ], "actionItems": [ ... ], "topics": [ ... ]
  }
}
```

Notes:

- `completeness` `TRUNCATED` means the bot stopped at its recording limit; the passages are what was captured until then. Receivers MUST accept all three values.
- `unknownSpeakerNumber` is optional. The CRM labels a passage `speakerName`, else "Unknown speaker N" when the number is set, else "Unknown speaker". The CRM never prints `speakerKey`.
- `summary` is null for NOT_ENOUGH_CONTENT, PENDING or missing; `READY` or `FAILED` otherwise (`FAILED` also means summaries disabled).
- `keyPoints`, `decisions`, `actionItems`, `topics` are JSON arrays passed through as stored. Items may be strings or objects; the CRM renders strings, or the `text`, `title` or `description` field of objects, defensively.
- Booking fields of the regular shape: `uid` is the booking uid, `startTime`/`endTime` ISO strings, organizer and attendees `{ name, email, timeZone, language: { locale }, utcOffset }`. Location precedence: the calendar event's video call url, then `metadata.videoCallUrl` of the booking, then the session meeting url; `location` keeps the `integrations:*` value only when no url is known.
- Size: can reach several hundred KB; the receiver MUST accept at least 2 MB.

## Once-per-transcript semantics

- Sent exactly once per `NotetakerTranscript`, claimed atomically via `webhookDispatchedAt`.
- Sent when the transcript is finalized AND its summary reached a terminal state (READY or FAILED), or right after finalize when no summary will be generated (not enough content, or generation task failed to start).
- All subscribers of one dispatch receive the same `createdAt`.
- Delivery is one attempt per subscriber, no retry. The receiver dedupes on `transcriptId` as well.
- Meeting contacts changed after the send are not re-sent.

## Subscribers

For one transcript the set of subscribers is the union, deduplicated by webhook id, of:

1. the booking owner's user-level webhooks subscribed to the trigger (platform webhooks matching the user included, as for other triggers);
2. the team webhooks with `includeMemberMeetings` on of the single team T the meeting is shared with, when all of these hold: the notetaker sharing scope of the booking resolves to `{ mode: TEAM, teamId: T }` (`specs/004`), the owner is an accepted member of T, the latest session with a transcript has `colleagueSharingDisclosed` true, and its results are not deleted.

Event-type webhooks, unflagged team webhooks, organization and OAuth-client webhooks are never used for this trigger.

## When it is NOT sent

- The session's `resultsDeletedAt` is set.
- The transcript has no passages.
- The booking has no owner (`userId` null), or the owner row cannot be loaded for the meeting payload.
- No subscriber exists (nothing is claimed in this case).
- The transcript was already claimed.
- Deleting a transcript or session in cal.diy later sends nothing and does not remove the CRM copy.

## Logging

Only identifiers (`transcriptId`, `sessionId`, `bookingId`, counts) are logged; never text, summaries, emails or secrets.

## Changelog

- v2, 2026-11-06: meeting payload for bookings without an event type; `source`; `TRUNCATED` documented; subscriber union with flagged team webhooks. Additive for receivers of v1 (`source` optional, regular shape unchanged).
- v1, 2026-11-04: initial.
