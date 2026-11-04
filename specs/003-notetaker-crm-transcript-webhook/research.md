# Research: Notetaker Transcript Webhook for the CRM

**Date**: 2026-11-04, amended 2026-11-06 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Findings come from reading cal.diy code (notetaker slice, `packages/features/webhooks`) and the production configuration.

## Facts

- cal.diy's notetaker (Recall.ai) stores `NotetakerSession`, `NotetakerTranscript`, `NotetakerTranscriptPassage`, `NotetakerSummary`. Nothing is sent out when they are ready.
- The transcripts are not Cal Video/Daily recordings. The enum value `RECORDING_TRANSCRIPTION_GENERATED` exists for Daily's flow and is already selectable in the webhook UI.
- Production: `ENABLE_ASYNC_TASKER=false`, so `NotetakerSyncTasker` runs inline and ignores `idempotencyKey`; `TASKER_ENABLE_WEBHOOKS=0`, so `sendOrSchedulePayload` calls `sendPayload` directly and there is no retry.
- Ad-hoc bookings (`metadata.notetakerAdHoc`) and calendar auto-join bookings (`metadata.notetakerCalendarMeeting`) have `eventTypeId` null and no `Attendee` rows; `CalendarEventBuilder.fromBooking` cannot build them.

## Decision 1: Reuse `RECORDING_TRANSCRIPTION_GENERATED`

- **Decision**: send the existing trigger with an optional `notetaker` block.
- **Rationale**: no enum migration, subscription UI and signing already work. The receiver tells the two origins apart by the block.
- **Alternatives**: a new `NOTETAKER_TRANSCRIPT_READY` trigger (enum change, UI changes, rejected as larger).

## Decision 2: Exactly-once by a database claim

- **Decision**: new nullable `NotetakerTranscript.webhookDispatchedAt`, claimed with `updateMany({ where: { id, webhookDispatchedAt: null }, data: { webhookDispatchedAt: now } })`; count 1 wins. User approved the column.
- **Rationale**: the tasker ignores idempotency keys in production, and finalize/summary paths can run twice.
- **Alternatives**: the tasker idempotency key (ignored when sync); an in-memory set (lost on restart, not multi-instance); a reused existing column (none fits).

## Decision 3: Claim after the payload is built, not before

- **Decision**: load, validate, find subscribers and build the payload first; claim only then.
- **Rationale**: a "no subscriber" or a build failure should not burn the single send. Delivery failure after the claim is accepted (no retry, see Decision 6).

## Decision 4: Subscriber scope follows the notetaker sharing rules (amended 2026-11-06)

- **Original (v1)**: `getWebhooks({ userId: booking.userId, eventTypeId: null, teamId: null, orgId: null, oAuthClientId: null, triggerEvent })`; platform webhooks the function returns for that user included, following the precedent of other triggers.
- **Amendment**: the same call additionally passes `memberSharingTeamIds`, which is `[T]` only when the meeting's results are shared with team T under the rules a colleague would be granted read access by (`NotetakerAccessService.isSharedViewer`): sharing scope `TEAM` for T, owner an accepted member of T, latest session with a transcript disclosed for colleague sharing, results not deleted. `getWebhooks` then also returns the webhooks of T that have `includeMemberMeetings` on (`specs/004`, Decision 5 there).
- **Rationale**: the transcript's audience inside cal.diy is the owner plus, under team sharing, the team. A flagged team webhook configured by a team admin stands in for those colleagues; it must not receive meetings they could not open. Event-type, unflagged team and org webhooks would reach people who were not given the transcript, so nulls are still passed for them.
- **Alternatives**: all webhooks of the event type (privacy widening, rejected); all team webhooks of every team the owner belongs to (rejected: leaks hosts-only meetings).

## Decision 5: Bookings without an event type get a meeting payload (amended 2026-11-06, supersedes "skipped in v1")

- **Original (v1)**: no `userId` or no event type: return silently.
- **Amendment**: a booking with no owner is still skipped. A booking without an event type is sent with a purpose-built meeting payload (`buildNotetakerMeetingBookingPayload`): owner as organizer, meeting contacts (`specs/004`) as attendees, `type: "notetaker_meeting"`, `eventTypeId: null`, `source` `ad_hoc` or `calendar_auto_join`. The gateway loads the booking, its owner and contacts in one repository call (`findMeetingForWebhook`) instead of `CalendarEventBuilder`.
- **Rationale**: the CRM must learn about meetings held outside cal.diy booking pages (the common sales case: a pasted Meet link or a calendar invite). Without attendees the CRM cannot match a person, so the contacts feature was built alongside; when there are none, the CRM queues the transcript in an inbox (companion spec).
- **Alternatives**: building `Attendee` rows for contacts so the regular payload works (rejected: attendees get notice emails, shared-results emails, transcript access and booking visibility); sending the regular payload with a synthetic event type (rejected: lies to the receiver).

## Decision 6: Synchronous delivery, no retry

- **Decision**: call `sendOrSchedulePayload` per subscriber in a try/catch and log failures.
- **Rationale**: matches production config and existing triggers. A retry queue is future work.

## Decision 7: Deletions do not propagate

- **Decision**: no event when a transcript or session is deleted in cal.diy; the CRM copy stays.
- **Rationale**: the CRM attachment is a record the CRM user owns; webhook delivery has no delete semantics in v1. Documented in the README for hosts.

## Decision 8: Payload size

- **Decision**: send the full passages inline; no truncation or pagination.
- **Rationale**: the CRM must not fetch URLs (user decision). Long meetings reach several hundred KB; the CRM inbound route must accept at least 2 MB for source `calcom` (checked on the CRM side).
- **Alternatives**: a signed fetch URL (rejected by the user), splitting into chunks (breaks once-per-transcript semantics).

## Decision 9: No custom payload template

- **Decision**: the `notetaker` block exists only in the default payload shape; subscriptions with a custom payload template or Zapier are not supported.
- **Rationale**: templates replace the body and would drop the block.

## Decision 10: Summary mapping

- **Decision**: READY and FAILED map to a summary object; NOT_ENOUGH_CONTENT, PENDING or missing map to null. FAILED also covers summaries disabled.
- **Rationale**: one terminal signal for the receiver without exposing internal statuses.

## Decision 11: `source` on every transcript payload (2026-11-06)

- **Decision**: `payload.source` is `"booking"` on the regular shape and `"ad_hoc"` / `"calendar_auto_join"` on the meeting shape, derived from the booking metadata markers. Optional in the type so older senders and other triggers stay valid.
- **Rationale**: the CRM shows where a meeting came from and applies different matching (staff filter, inbox) per source; `eventTypeId === null` alone cannot tell ad-hoc from calendar.
