# Contract: Notifications

Part of the Phase 1 contracts of [../spec.md](../spec.md). Messages are sent by the task defined in [tasker.md](./tasker.md).

This contract is the catalog of messages the notetaker feature sends to people: emails to hosts and attendees, a web push and in-app prompt to hosts, and the two strings the bot shows inside the meeting. It fixes who gets what and when, and what each message must and must not say. It does not fix final copy.

## Rules that apply to every message

- No message ever contains transcript or summary text (FR-020). Messages say that something is available and link to it.
- Every user-facing string is localized through `packages/i18n/locales/en/common.json` (FR-034).
- Links point to `${WEBAPP_URL}/booking/{uid}/notetaker`.
- Every message is sent by the task `notetaker.send-notification`, whose payload is `{ kind: NotetakerNotificationKind, bookingId: number, sessionId: string | null }` and which calls `NotetakerNotificationService.send`.
- Session-scoped kinds (`ADMIT_PROMPT`, `RESULTS_READY`, `FAILED`) are enqueued only on the winning status transition, with the Trigger idempotency key `notetaker:<KIND>:<sessionId>`.
- The `ATTENDEE_NOTICE` is sent even when the event type has emails disabled, because it is a transparency requirement (default, pending confirmation; open question 22).

## Catalog

`NotetakerNotificationKind` has six values.

| Kind | To | When | FR | Email class |
|---|---|---|---|---|
| `ATTENDEE_NOTICE` | all attendees | Host turns the notetaker on; booking created with the inherited default (including recurring occurrences); every dispatch | FR-014 | `AttendeeNotetakerNoticeEmail` |
| `ADMIT_PROMPT` | enabling hosts (email, web push, in-app banner) | Session reaches `WAITING_TO_BE_ADMITTED` | FR-025 | `OrganizerNotetakerAdmitPromptEmail` |
| `RESULTS_READY` | enabling hosts | Session `READY` or `ENDED_EARLY` | FR-020 | `OrganizerNotetakerResultsReadyEmail` |
| `FAILED` | enabling hosts | Session `FAILED` | FR-024 | `OrganizerNotetakerFailedEmail` |
| `TURNED_OFF` | enabling hosts | Location became unsupported | Edge case | `OrganizerNotetakerTurnedOffEmail` |
| `SHARED_WITH_ATTENDEES` | attendees | Host shares | FR-027 | `AttendeeNotetakerSharedEmail` |

### `ATTENDEE_NOTICE`

- **Recipients:** the current `Attendee.email` values of the booking, minus the addresses in the booking's own `BookingNotetaker.notifiedAttendeeEmails`, minus those of bookings sharing the same non-null `recurringEventId`. For seated events the notice goes to all attendees (open question 17). The notetaker's Google account is never a recipient: it is added to the calendar event only, never to the booking's attendees.
- **Triggers:** all go through `notetaker.send-notification`.
  - The host turns the notetaker on (`setEnabled` off→on), enqueued by `NotetakerChoiceService`.
  - A booking is created with the inherited event-type default (`onBookingCreated`, `onRecurringOccurrenceCreated`), enqueued by `NotetakerChoiceService`. This includes each recurring occurrence.
  - Every dispatch, as a catch-all, enqueued by `NotetakerDispatchService`.
- **Dedupe:** per attendee, not per transition. After sending, the recipients are appended to `BookingNotetaker.notifiedAttendeeEmails` and `attendeesNotifiedAt` is set to the time of the most recent send. An address is not notified again on a later trigger, across a recurring series, or when the notetaker is turned off and on again. Disabling does not clear `notifiedAttendeeEmails`. A reschedule copies it to the new booking.
- **Attendees added later:** guests and new seats are covered by the dispatch-time send, about two minutes before the start. No hook is added to adding guests or seat handling.
- **Pending bookings:** the notice is also sent for a pending booking, worded "if this meeting takes place".
- **Channels:** email only.
- **Must tell the reader:**
  - the meeting will be transcribed by an automated notetaker;
  - on whose behalf (the host or organization);
  - which meeting it concerns (title, date and time as in other booking emails);
  - what to do to object or to have the notetaker removed during the meeting.
- **Must not contain:** transcript or summary text; a link to content (attendees have no access until a host shares it, so the notice does not point to the notetaker page).

### `ADMIT_PROMPT`

- **Recipients:** the enabling hosts (see "Recipients of host notices").
- **Trigger and dedupe:** sent when the session reaches `WAITING_TO_BE_ADMITTED`, enqueued by `NotetakerSessionEventService` on that transition. Sent once per session (idempotency key `notetaker:ADMIT_PROMPT:<sessionId>`), so a retry that creates a new session sends a new prompt.
- **Channels:** email, web push through `sendNotification`, and an in-app banner driven by status polling.
- **Must tell the reader:**
  - the notetaker is waiting to be let into the meeting;
  - which meeting;
  - that it must be admitted in the meeting platform, and that without admission nothing is transcribed;
  - a link to the booking's notetaker page.
- **Must not contain:** transcript or summary text. The push and the banner carry the same facts in shorter form.

### `RESULTS_READY`

- **Recipients:** the enabling hosts.
- **Trigger and dedupe:** sent when the first summary generation settles (summary `READY`, or `FAILED` once `attempts` reaches 3), enqueued by `NotetakerSummaryService`; also when `NotetakerFinalizeService` sets the summary to `NOT_ENOUGH_CONTENT`. Once per session (idempotency key `notetaker:RESULTS_READY:<sessionId>`). It is not re-sent when the summary is re-requested.
- **Channels:** email.
- **Must tell the reader:**
  - the transcript is available (and the summary, when one exists or has been queued);
  - which meeting;
  - when the session ended early (`ENDED_EARLY`), that it ended early and the outcome reason, in plain terms (for example at a participant's or host's request);
  - when the transcript is truncated (`TRUNCATED`), that it is truncated;
  - when there is no summary (failed or not enough content), that the summary is missing;
  - a link to the booking's notetaker page.
- **Must not contain:** transcript or summary text, excerpts, or action items.

### `FAILED`

- **Recipients:** the enabling hosts.
- **Trigger and dedupe:** sent when the session reaches `FAILED`. Once per session (idempotency key `notetaker:FAILED:<sessionId>`). Enqueued by:
  - `NotetakerSessionEventService` for a pre-admission end;
  - `NotetakerFinalizeService` when the session has zero passages;
  - `NotetakerDispatchService` on a 422 from the bot service, a missing meeting link at a supported location, the give-up deadline, and the watchdog.
- **Channels:** email.
- **Must tell the reader:**
  - no transcript was produced for the meeting;
  - the specific reason (FR-024): not admitted, meeting did not start, no speech detected, removed by participant, stopped by host, interrupted, length limit reached, or meeting link unusable;
  - whether the notetaker can be turned on again, which is possible only while the booking has not ended (`now < booking.endTime`) and rejoin is not blocked (`rejoinBlocked` is false);
  - a link to the booking's notetaker page.
- **Must not contain:** transcript text, internal error codes or provider error messages.

### `TURNED_OFF`

- **Recipients:** the enabling hosts.
- **Trigger and dedupe:** sent only when the handler actually flips `enabled` from true to false, so a repeat sends nothing. Two triggers:
  - the booking's location changes to one the notetaker does not support (`NotetakerChoiceService.onBookingLocationChanged`);
  - an unsupported location is found at dispatch (`NotetakerDispatchService`), where the choice is turned off as `DISABLED` / `SYSTEM` with `detail.reason = "UNSUPPORTED_LOCATION"`.
- **Channels:** email.
- **Must tell the reader:**
  - the notetaker was turned off for this booking;
  - why (the new location is not a supported meeting platform);
  - that no transcript will be made unless the location is changed back to a supported platform and the notetaker is enabled again;
  - a link to the booking's notetaker page.
- **Must not contain:** transcript or summary text.

### `SHARED_WITH_ATTENDEES`

- **Recipients:** the attendees of the booking.
- **Trigger and dedupe:** sent when a host shares the booking's transcript and summary with attendees (FR-027), enqueued by `NotetakerResultsService.setSharing`. Sent on each creation of the grant row, so sharing again after the host revokes and shares anew is a new share. A repeat `setSharing(true)` while the grant exists sends nothing. No notice is sent on revocation.
- **Channels:** email.
- **Must tell the reader:**
  - the host has shared the meeting's transcript and summary with them;
  - which meeting, and who shared it;
  - a link to the booking's notetaker page.
- **Must not contain:** transcript or summary text, even a preview.

## Recipients of host notices

Host notices are `ADMIT_PROMPT`, `RESULTS_READY`, `FAILED` and `TURNED_OFF`. Recipients are the distinct users with an `ENABLED` activity on the booking. When the choice was inherited from the event-type default, the `ENABLED` activity has `actorType = SYSTEM` and no user, and the notice goes to the organizer (Decision 9; open question 14).

## Advance disclosure on the booking page

This is not an email. When the event-type default is on, the public booking page shows, before the booker confirms, that the meeting will be transcribed (User Story 5, FR-014). The page reads the disclosure from the public procedure `publicViewer.notetakerDisclosure`; see [trpc-notetaker.md](./trpc-notetaker.md). The disclosure covers the person booking. Other attendees (guests, and everyone on a booking created by someone else) are covered by the `ATTENDEE_NOTICE`, which bookings made under the default also receive.

## In-meeting strings

Both strings are generated by the app, localized through `packages/i18n/locales/en/common.json`, and sent to the bot in the join request. The bot does not compose them. The notice is always posted; the display name is applied only where the platform lets a participant choose its name.

| i18n key | Shown | Must convey |
|---|---|---|
| `notetaker_display_name` | As the notetaker's participant name when it joins as a guest (FR-012). Not shown in Google Meet account mode, where participants see the name of the notetaker's Google account | That it is an automated notetaker, and which host or organization it acts for. Designed as "{{appName}} Notetaker for {{hostName}}". |
| `notetaker_meeting_notice` | As a message visible to all participants when transcription begins (FR-013) | That the meeting is being transcribed; for whom; how to stop it (remove the notetaker from the meeting). |

Because the display name is not shown on every platform, `notetaker_meeting_notice` and the `ATTENDEE_NOTICE` email are the two messages that must always name the host (FR-012). Both already do; a change to either string must keep the host's name.

**Language (default, pending confirmation):** both strings are rendered in the organizer's locale (open question 11).

## Files

To be added or changed:

- `packages/emails/templates/attendee-notetaker-notice-email.ts`
- `packages/emails/templates/organizer-notetaker-admit-prompt-email.ts`
- `packages/emails/templates/organizer-notetaker-results-ready-email.ts`
- `packages/emails/templates/organizer-notetaker-failed-email.ts`
- `packages/emails/templates/organizer-notetaker-turned-off-email.ts`
- `packages/emails/templates/attendee-notetaker-shared-email.ts`
- `packages/emails/src/templates/Notetaker*.tsx` (React templates, one per class) and `packages/emails/src/templates/index.ts` (changed, to export them)
- `packages/emails/notetaker-email-service.ts`
- `packages/i18n/locales/en/common.json` (changed)

Each class file follows the existing pair `packages/emails/templates/organizer-daily-video-download-transcript-email.ts` and `packages/emails/src/templates/DailyVideoDownloadTranscriptEmail.tsx`. The class extends `BaseEmail`, takes its translator from the recipient's language, builds the payload in `getNodeMailerPayload()` and renders the React template through `renderEmail("<TemplateName>", props)`. The template wraps its content in `V2BaseEmailHtml` and takes the translator as a `language` prop. `packages/emails/notetaker-email-service.ts` is the entry point `NotetakerNotificationService` calls to send each class.
