# Contract: delivery to flagged team webhooks

**Spec**: [../spec.md](../spec.md) | **Transcript contract**: [`specs/003/contracts/transcript-webhook.md`](../../003-notetaker-crm-transcript-webhook/contracts/transcript-webhook.md)

A flagged team webhook receives exactly the same envelope, headers, signature and payload shapes as the booking owner's own webhook would for the same event. This document fixes *when* it is a subscriber.

## Matching rule

For a booking B owned by user U, `resolveMemberSharingTeamIds({ ownerUserId: U, eventType, bookingMetadata }, membershipLookup)` returns `[T]` when all hold, else `[]`:

1. A sharing team T is derived (`deriveNotetakerSharingTeam`):
   - B's event type belongs to team T, or
   - B's event type is personal and its `EventTypeNotetakerSettings.sharingTeam` is T, or
   - B has no event type and its metadata `notetakerSharingTeamId` is T (ad-hoc and calendar meetings).
2. The sharing mode is `TEAM`: the event type's `notetakerSettings.sharingMode` (default `HOSTS_ONLY`), or implicitly `TEAM` for an event-type-less booking with a team. `HOSTS_ONLY` and `SELECTED_PEOPLE` never match.
3. `resolveNotetakerSharingScope` resolves to `{ mode: "TEAM", teamId: T }` (for a personal event type or an ad-hoc meeting this already requires the sharing owner to be an accepted member of T).
4. U is an accepted member of T (checked explicitly when the source has no sharing owner, i.e. a team event type).

`U` null (no owner) → `[]`. Dynamic event types (no id) → `[]`. Any error in a sender → `[]` and an error log with ids.

Subscribers of the event = `getWebhooks({ userId: U, eventTypeId, teamId: null, orgId: null, oAuthClientId, triggerEvent, memberSharingTeamIds })`, i.e. the previous set plus every active, non-platform webhook with `teamId` in `memberSharingTeamIds`, `includeMemberMeetings = true` and the trigger selected. Duplicates by id are removed.

## Covered triggers and senders

| Trigger | Sender | Note |
|---------|--------|------|
| BOOKING_CREATED, BOOKING_RESCHEDULED | `RegularBookingService` (`getMemberSharingTeamIds`), `handleConfirmation` (after confirmation) | |
| BOOKING_REQUESTED | `handleBookingRequested` | |
| BOOKING_CANCELLED | `handleCancelBooking`, `requestReschedule.handler` | |
| BOOKING_REJECTED | `confirm.handler` (reject branch) | |
| MEETING_STARTED, MEETING_ENDED | scheduled per subscriber by `scheduleTrigger` from `RegularBookingService` and `handleConfirmation`; backfilled by `fetchBookingsFromWebhook` for flagged webhooks; fired by the `webhookTriggers` cron | |
| RECORDING_TRANSCRIPTION_GENERATED | `NotetakerTranscriptWebhookService` | additionally requires the latest session with a transcript to be `colleagueSharingDisclosed` and not `resultsDeletedAt` (`isTranscriptSharedWithTeam`), resolved at send time |

Not covered (reach only the owner's subscribers): BOOKING_PAYMENT_INITIATED, BOOKING_PAID, BOOKING_NO_SHOW_UPDATED, OOO_CREATED, FORM_SUBMITTED*, AFTER_HOSTS_CAL_VIDEO_NO_SHOW, AFTER_GUESTS_CAL_VIDEO_NO_SHOW, INSTANT_MEETING, RECORDING_READY.

## Backfill and reconciliation of MEETING_* rows

- `fetchBookingsFromWebhook(webhook)` for a flagged webhook adds `fetchMemberSharingBookings(teamId, excludeIds)`: future (`startTime > now`, `endTime > now`) ACCEPTED bookings owned by accepted members of T that either have no event type and `metadata.notetakerSharingTeamId = T`, or a personal event type with `notetakerSettings.sharingMode = TEAM` and `sharingTeamId = T`, re-checked through `resolveMemberSharingTeamIds`. Team event-type bookings are already covered by the existing team branch.
- Runs on create, on activation, on adding a MEETING_* trigger (existing paths through `updateTriggerForExistingBookings`).
- On a flag change of an active webhook (`previousIncludeMemberMeetings` differs): for triggers kept selected, rows for the members' shared bookings are scheduled (flag on) or deleted (flag off). Failures are logged with webhook and team ids; the edit still succeeds.
- Not handled: a member leaving T or an event type's sharing changing after rows were scheduled (known gap).

## Guarantees

- A webhook without the flag never receives anything it did not receive before.
- A flagged webhook never receives an event of a booking whose owner is not currently an accepted member of its team, nor of a hosts-only or selected-people meeting.
- Transcripts additionally never reach it unless a colleague of the team could read them in cal.diy.
