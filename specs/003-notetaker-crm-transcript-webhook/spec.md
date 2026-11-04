# Feature Specification: Notetaker Transcript Webhook for the CRM

**Feature Branch**: `003-notetaker-crm-transcript-webhook`

**Created**: 2026-11-04

**Amended**: 2026-11-06 (phase 2, see Changelog)

**Status**: Draft

**Input**: User description: "Meeting transcripts made by cal.diy's own notetaker must reach the Open Mercato CRM, so that a finished meeting shows its transcript and summary on the person's record. cal.diy sends nothing out for notetaker results today."

**Builds on**: `specs/001-meeting-transcription` (the notetaker) and `specs/002-speaker-names-team-sharing` (speaker names, sharing). Terms such as host, booking, notetaker, transcript and summary keep their meaning from those specifications.

**Extended by**: `specs/004-notetaker-crm-meeting-contacts-team-webhook` (meeting contacts for bookings without an event type, the team webhook opt-in). Phase 2 of this specification describes what that feature changed here; the mechanics live there.

**Companion change**: Open Mercato, branch `feat/calcom-integration`, spec `.ai/specs/2026-11-04-calcom-crm-integration.md` (package `@open-mercato/webhook-calcom`, inbound URL `POST /api/webhooks/inbound/calcom`). This specification covers only the cal.diy side; the receiving side is specified there.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A finished transcript is pushed to the CRM once (Priority: P1)

A host has connected their cal.diy account to the CRM by adding a webhook for the "recording transcription generated" event. After a notetaker meeting ends and the transcript and summary are ready, the CRM receives one message carrying the booking, the transcript passages and the summary, and attaches them to the person the meeting was held with.

**Why this priority**: This is the whole feature. Without it the CRM never learns that a transcript exists.

**Independent Test**: Subscribe a test receiver to the event, run a notetaker meeting to completion with the fake bot, and check the receiver gets exactly one signed request with the booking fields and the `notetaker` block.

**Acceptance Scenarios**:

1. **Given** a host with a subscribed webhook and a finished transcript whose summary is ready, **When** the summary settles, **Then** the receiver gets one request with the transcript passages and the summary.
2. **Given** a finished transcript whose summary failed or summaries are switched off, **When** the result settles, **Then** the receiver gets one request with `summary.status` `FAILED`.
3. **Given** a transcript too short to summarise, **When** the transcript is finalized, **Then** the receiver gets one request with `summary` null.
4. **Given** the same transcript is finalized or summarised again (retry, duplicate job), **When** the result settles again, **Then** no second request is sent.
5. **Given** a meeting the host recorded without an event type (ad-hoc link, calendar auto-join), **When** its transcript settles, **Then** the receiver gets one request whose booking part is the meeting payload (`type` `notetaker_meeting`, `eventTypeId` null, organizer = the host, attendees = the meeting's contacts, possibly none) with the same `notetaker` block. *(phase 2)*

---

### User Story 2 - Only the people the sharing rules allow receive it (Priority: P1)

A transcript is private to the people the existing sharing rules allow. The webhook must not widen that audience.

**Why this priority**: A transcript leaving cal.diy is a privacy event; it must follow the existing rules.

**Independent Test**: Create a user-level webhook for another user, a team-level webhook without the member-meetings flag that covers the event type, and a flagged team webhook of a team the meeting is not shared with; check none receives the request. Then share the meeting with the flagged team (notetaker sharing set to that team, the colleague notice shown in the meeting) and check that webhook now receives it.

**Acceptance Scenarios**:

1. **Given** webhooks owned by the booking owner and by other users, **When** a transcript is dispatched, **Then** the booking owner's user-level subscriptions (including platform webhooks that match them, as for other triggers) are called and other users' are not.
2. **Given** no subscription for the event, **When** a transcript settles, **Then** nothing is sent and the transcript stays eligible, so a webhook added before a later retrigger still works.
3. **Given** the results were deleted by the host or have no passages, **When** the result settles, **Then** nothing is sent.
4. **Given** a team webhook with "include meetings of all team members" on, a meeting whose notetaker results are shared with that whole team, and a session in which the colleague-sharing notice was shown, **When** the transcript settles, **Then** that team webhook is called once, in addition to the owner's own subscriptions. *(phase 2)*
5. **Given** the same flagged team webhook, **When** the meeting's sharing is hosts only or selected people, the notice was not shown, the results were deleted, or the owner is no longer an accepted member of that team, **Then** the team webhook is not called. *(phase 2)*
6. **Given** a team webhook without the flag, or an event-type, organization or OAuth-client webhook, **When** a transcript settles, **Then** it is never called for this trigger. *(unchanged)*

---

### User Story 3 - Failures never disturb the notetaker (Priority: P2)

A slow or broken CRM must not fail finalization, summary generation or the host's view of results.

**Independent Test**: Make the receiver throw; finalize and summarise; check the transcript and summary are saved and the status is unchanged.

**Acceptance Scenarios**:

1. **Given** a receiver that errors for one of two subscribers, **When** the result settles, **Then** the other subscriber is still called and no error reaches the caller.
2. **Given** an internal error while building the payload, **When** the result settles, **Then** it is logged by id only and the notetaker flow continues.

---

### Edge Cases

- A booking with no owner (`userId` null) is still skipped. Bookings without an event type are no longer skipped (phase 2): they get the meeting payload; their contacts come from `specs/004` and may be empty, in which case `attendees` is `[]`.
- A booking without an event type whose metadata carries neither the ad-hoc nor the calendar-meeting marker is reported with `source` `ad_hoc`, because an event-type-less booking is never a regular booking.
- The owner of a no-event-type booking cannot be loaded (deleted user): nothing is sent, a warning with the booking id is logged, the transcript stays unclaimed.
- A booking with no matching subscription at settle time is not retried later; the webhook must exist beforehand.
- Contacts added or changed after the transcript was sent are not re-sent; the host sees a note in the UI (`specs/004`).
- Deleting a transcript or session in cal.diy does not delete anything in the CRM.
- Daily's legacy `RECORDING_TRANSCRIPTION_GENERATED` events carry no `notetaker` block; the receiver treats them as no-ops.
- The request can be several hundred KB for long meetings; the receiver must accept at least 2 MB.
- Delivery is a single attempt, no retry (the async tasker is off in production).
- Speaker names may be absent (`speakerNamesAvailable` false or null); passages then carry `speakerName` null.
- `completeness` can be `COMPLETE`, `PARTIAL` or `TRUNCATED` (the bot cut the recording at its limit); the CRM must accept all three.
- The same webhook row can match both as the owner's and as a flagged team webhook only in theory (flagged webhooks have no owner); subscribers are deduplicated by id anyway.
- A member who leaves the team or turns team sharing off before the transcript settles: the team webhook is not called, because the sharing scope is resolved at send time, not when the booking was made.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST send the existing trigger `RECORDING_TRANSCRIPTION_GENERATED` once per notetaker transcript, through the existing webhook signing and delivery code, to subscriptions that selected that trigger.
- **FR-002**: The send MUST happen when the transcript is finalized and its summary reached a terminal state (READY or FAILED), or immediately after finalize when no summary will be generated.
- **FR-003**: The payload MUST be the normal booking webhook payload for the booking plus a `notetaker` block as in [contracts/transcript-webhook.md](./contracts/transcript-webhook.md). For a booking without an event type the booking part MUST be the meeting payload described there instead. Every transcript payload MUST carry `source` (`booking`, `ad_hoc` or `calendar_auto_join`). *(phase 2)*
- **FR-004**: The send MUST be exactly once per transcript, enforced by an atomic claim in the database, not by the tasker.
- **FR-005**: The system MUST NOT send when the session's results were deleted, the transcript has no passages, the booking has no owner, the owner cannot be loaded, or no subscriber exists.
- **FR-006**: Subscribers MUST be the booking owner's user-level webhooks plus, when and only when the meeting's notetaker results are shared with a whole team T (sharing mode TEAM, the owner an accepted member of T, the colleague-sharing notice shown in the latest session with a transcript, results not deleted), the webhooks of team T that opted into member meetings. No other event-type, team, organization or OAuth-client webhook MUST ever be used for this trigger. *(phase 2)*
- **FR-007**: The system MUST NOT log transcript text, summary text, secrets or participant emails; only identifiers.
- **FR-008**: The sending service MUST NOT throw; a failure for one subscriber MUST NOT stop others.
- **FR-009**: Existing behaviour of finalize, summary generation and the booking webhooks MUST NOT change; the new payload fields are optional and additive.

### Key Entities

- **Notetaker transcript**: gains one nullable marker, `webhookDispatchedAt`, set when the send was claimed.
- **Transcript webhook payload**: booking payload (or meeting payload) plus the `notetaker` block (version 1) plus `source`.
- **Meeting contact** (`specs/004`): a customer email, optionally with a name, attached to a booking without an event type; becomes an attendee entry of the meeting payload. Not an attendee of the booking.
- **Subscriber**: a webhook row of the booking owner, or a flagged team webhook of the team the meeting is shared with, subscribed to `RECORDING_TRANSCRIPTION_GENERATED`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of finished notetaker meetings with a subscribed owner, the receiver gets exactly one request per transcript, also when finalize and summary jobs run twice.
- **SC-002**: No request is sent for results deleted, empty, or owned by no subscribed user (verified by unit tests for each case).
- **SC-003**: A failing receiver changes no stored transcript, summary or status.
- **SC-004**: The signature and headers are identical to those of existing booking webhooks, so the CRM verifies them with the same rule.
- **SC-005**: A flagged team webhook receives a transcript only when a team member could read it in cal.diy through team sharing (verified by unit tests for TEAM, HOSTS_ONLY, SELECTED_PEOPLE, undisclosed session, deleted results, owner not a member). *(phase 2)*

## Assumptions

- The user approved a new nullable column on `NotetakerTranscript` (Prisma migration, additive).
- Production runs with `ENABLE_ASYNC_TASKER=false` and `TASKER_ENABLE_WEBHOOKS=0`: delivery is synchronous, one attempt.
- Each host creates their own user-level webhook per CRM tenant with the same secret, or a team admin creates one flagged team webhook (`specs/004`); the CRM should be connected through one of the two, not both, to avoid double delivery of the same meeting.
- `MEETING_ENDED` events for the CRM are produced by a server cron on `/api/cron/webhookTriggers` (outside this change; see quickstart).

## Changelog

- 2026-11-04: initial version (user-level webhooks, bookings with an event type only).
- 2026-11-06 (phase 2, implemented together with `specs/004`): transcripts of bookings without an event type are sent with the meeting payload; `payload.source` added to every transcript webhook; `completeness` documented as including `TRUNCATED`; subscriber scope extended with flagged team webhooks of the team the meeting is shared with; US2 renamed, scenarios 4 to 6 added, US1 scenario 5 added; FR-003, FR-005, FR-006, FR-009 amended; SC-005 added; edge cases and assumptions updated; research Decisions 4 and 5 superseded.
