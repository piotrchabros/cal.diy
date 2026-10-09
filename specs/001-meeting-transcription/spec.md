# Feature Specification: Meeting Transcription Notetaker

**Feature Branch**: `001-meeting-transcription`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "I want to integrate meeting transcription with the calendar application, so that a user can choose to which calendar events the bot will join and auto transcribe. the transcriptions should be saved back in the calendar scheduling app, with a summary"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send the notetaker to a chosen meeting and get the transcript back (Priority: P1)

A host opens an upcoming booking held on a supported platform and turns the notetaker on. At the meeting time the notetaker joins as a visible participant and transcribes. After the meeting the transcript appears on that booking, with each passage attributed to a speaker and timestamped.

**Why this priority**: This is the core request; every other story builds on it.

**Independent Test**: Enable the notetaker on one booking, hold the meeting with two speakers, then open the booking and read a speaker-attributed transcript.

**Acceptance Scenarios**:

1. **Given** an upcoming confirmed booking on a supported platform, **When** the host turns the notetaker on, **Then** the booking shows the notetaker is scheduled to join and the choice persists.
2. **Given** the notetaker is on, **When** the meeting starts and the notetaker is admitted, **Then** it appears as a clearly named participant and the booking shows transcription in progress.
3. **Given** a transcribed meeting has ended, **When** the host opens the booking, **Then** the full transcript is shown with speaker names and timestamps in spoken order.
4. **Given** the notetaker is on, **When** the host turns it off before the meeting starts, **Then** the notetaker does not join and no transcript is created.
5. **Given** a booking where the notetaker was never turned on, **When** the meeting takes place, **Then** no notetaker joins and nothing is transcribed.
6. **Given** a transcript has become available, **When** processing completes, **Then** the host who enabled the notetaker is notified with a link to the booking.

---

### User Story 2 - Participants know they are being transcribed and can object (Priority: P1)

Everyone in the meeting can tell a notetaker is present, who sent it and why. Attendees are told before the meeting. Any participant can have it removed.

**Why this priority**: Transcribing people without transparency is unacceptable legally and reputationally; the feature cannot ship without it.

**Independent Test**: Join as a guest; check the advance notice, the notetaker's name and the in-meeting message; remove the notetaker and confirm transcription stops.

**Acceptance Scenarios**:

1. **Given** the notetaker is enabled before the meeting, **When** the choice is saved (or at booking time, if it was already enabled), **Then** every attendee receives a notice that the meeting will be transcribed and on whose behalf.
2. **Given** the notetaker joins, **When** it enters, **Then** its display name identifies it as an automated notetaker and names the host or organization it acts for.
3. **Given** the notetaker has joined, **When** it starts transcribing, **Then** a message visible to all participants in the meeting chat states that the meeting is being transcribed, for whom, and how to stop it.
4. **Given** transcription is in progress, **When** any participant removes the notetaker or a host stops it from the application, **Then** transcription stops within 10 seconds and the notetaker does not rejoin that meeting.
5. **Given** transcription was stopped on request, **When** the host views the booking, **Then** the content captured up to that point is labelled as ended early at a participant's or host's request.

---

### User Story 3 - Read a summary instead of the whole transcript (Priority: P2)

Alongside the transcript, the booking shows a short summary: overview, key points, decisions and action items.

**Why this priority**: Explicitly requested and the main time-saver, but it depends on a transcript existing.

**Independent Test**: After a transcribed meeting, open the booking and compare the summary to what was said.

**Acceptance Scenarios**:

1. **Given** a completed transcript, **When** processing finishes, **Then** a summary with an overview, key points, decisions and action items (with owners where stated) is shown on the booking above the transcript.
2. **Given** a meeting held in a language other than the host's interface language, **When** the summary is produced, **Then** it is written in the language predominantly spoken in the meeting.
3. **Given** a transcript with too little speech to summarize, **When** processing finishes, **Then** the booking states that no summary could be produced and still shows the transcript.
4. **Given** the summary failed but the transcript succeeded, **When** the host opens the booking, **Then** the transcript is available and the host can request the summary again.

---

### User Story 4 - Always know what the notetaker did (Priority: P2)

For every booking where the notetaker was enabled, the host can see its current state. If no transcript was produced, the host sees a specific reason and is notified.

**Why this priority**: An unattended notetaker that fails silently destroys trust, and because a person may have to admit it, failures will be routine.

**Independent Test**: Enable the notetaker, never admit it, and confirm the booking shows the status failed with the reason "not admitted" and the host is notified.

**Acceptance Scenarios**:

1. **Given** the notetaker is enabled, **When** the host views the booking at any time, **Then** one status is shown: scheduled, waiting to be admitted, transcribing, processing, ready, ended early, or failed with a reason.
2. **Given** the notetaker is waiting to be admitted, **When** the wait limit passes without admission, **Then** it leaves, the booking shows the status failed with the reason "not admitted", and the host is notified.
3. **Given** the notetaker is waiting to be admitted, **When** the meeting is in progress, **Then** the host is prompted (in the application and by notification) to admit it.
4. **Given** the notetaker loses its connection mid-meeting, **When** it cannot return, **Then** the partial transcript is kept, labelled incomplete, and the point of interruption is indicated.

---

### User Story 5 - Turn the notetaker on by default for a type of meeting (Priority: P3)

A host sets an event type so that new bookings of that type have the notetaker on, while still being able to turn it off per booking.

**Why this priority**: Convenience for frequent users; per-booking opt-in already delivers the value.

**Independent Test**: Set the default on an event type, create a booking, and confirm the notetaker is on and the booking page disclosed it.

**Acceptance Scenarios**:

1. **Given** an event type with the default on, **When** a new booking is made, **Then** the notetaker is enabled for that booking.
2. **Given** an event type with the default on, **When** a person views the public booking page, **Then** they see before confirming that the meeting will be transcribed.
3. **Given** a booking that inherited the default, **When** the host turns the notetaker off for that booking, **Then** only that booking is affected.
4. **Given** the default is changed, **When** existing bookings are viewed, **Then** their previous notetaker choice is unchanged.
5. **Given** an event type whose meeting location is not a supported platform, **When** the host views the setting, **Then** it is unavailable with an explanation.

---

### User Story 6 - Share, export and delete the results (Priority: P3)

Hosts control who else sees the transcript and summary and can remove them permanently.

**Why this priority**: Needed for collaboration and data hygiene, but the feature is useful when private to hosts.

**Independent Test**: Share with the booking's attendees and confirm that only they gain access; delete and confirm no one has access.

**Acceptance Scenarios**:

1. **Given** a ready transcript, **When** a host shares it with the booking's attendees, **Then** those attendees can view the transcript and summary and no one else can.
2. **Given** a shared transcript, **When** the host revokes sharing, **Then** any attendee who next tries to open the transcript or summary is refused access.
3. **Given** a ready transcript, **When** a host exports it, **Then** they receive a document containing the summary and the speaker-attributed transcript.
4. **Given** a host deletes the transcript, **When** deletion is confirmed, **Then** transcript and summary are permanently removed for everyone and the booking shows they were deleted.
5. **Given** a person who is neither a host nor someone it was shared with, **When** they try to open the transcript, **Then** access is refused.
6. **Given** any action taken on the notetaker or its results, **When** a host views the booking's history, **Then** the action, who took it and when are listed.

---

### Edge Cases

- **What if the notetaker is not admitted?** It waits up to 10 minutes after asking to join, then leaves. The status is failed, with the reason "not admitted", and the host is notified.
- **What if the meeting never starts?** If no one else joins within 15 minutes of the scheduled start, the notetaker leaves. The status is failed, with the reason "meeting did not start", and there is no transcript.
- **What if the booking is rescheduled?** The notetaker choice carries to the new time; it does not join at the old time.
- **What if the booking is cancelled or rejected?** The notetaker does not join and any pending session is cancelled.
- **What if the meeting link or location changes before the start?** The notetaker uses the link current at join time. If the new location is unsupported, the notetaker is turned off and the host is told before the meeting.
- **What if the meeting is on an unsupported platform, in person, by phone, or on built-in video?** The notetaker option is unavailable, with an explanation. For built-in video, its existing transcription remains the route.
- **What if no speech is detected?** The status is failed, with the reason "no speech detected". There is no summary, and an empty transcript is not presented as a success.
- **What if the meeting is very long?** Transcription continues up to 4 hours of meeting time. Then the notetaker leaves, and the transcript is kept and labelled as truncated at the limit.
- **What if the meeting overruns its scheduled end?** The notetaker stays while participants remain, up to the 4-hour limit.
- **What if everyone else leaves?** The notetaker leaves within 2 minutes of being the only participant.
- **What about recurring bookings?** The host can enable the notetaker for a single occurrence or for all future occurrences. Each occurrence gets its own transcript and summary.
- **What if several hosts are on one booking?** Any host can turn the notetaker on or off and the latest choice applies. Only one notetaker joins, and one transcript is produced that all hosts of the booking can see.
- **What if a participant objects?** They can remove the notetaker; it leaves and does not return, and the content captured so far is labelled as ended early.
- **What if the notetaker fails mid-meeting?** It tries to rejoin once. If it cannot, the partial transcript is kept and labelled incomplete.
- **What if the notetaker is enabled after the meeting has started?** It asks to join within 1 minute of being enabled and the transcript is marked as starting late. Enabling it after the meeting has ended is not possible.
- **What if the booking is still awaiting confirmation or payment?** The choice is stored, but the notetaker joins only if the booking is confirmed by the start time.
- **What if back-to-back bookings reuse the same meeting link?** Each booking has its own session and content is never merged across bookings.
- **What if a speaker cannot be identified?** The passage is attributed to a numbered "Unknown speaker" rather than guessed.
- **What if a host has several simultaneous bookings?** Each enabled booking gets its own notetaker.
- **What if the host's account or the booking is deleted?** The associated transcripts and summaries are deleted with it.

## Requirements *(mandatory)*

### Functional Requirements

*Choosing meetings*

- **FR-001**: Users MUST be able to choose, per meeting, whether the notetaker joins it; the notetaker is off unless the user turns it on. Meetings eligible for selection are bookings made through this application; events that exist only on a user's connected external calendars are not eligible.
- **FR-002**: System MUST offer the notetaker only for meetings held on a supported platform (Google Meet at launch, then Microsoft Teams) and MUST explain why it is unavailable otherwise.
- **FR-003**: Any host of a booking MUST be able to turn the notetaker on or off at any time until the meeting ends; the most recent choice applies.
- **FR-004**: Users MUST be able to set a per-event-type default so that new bookings of that type start with the notetaker on; the default MUST NOT alter existing bookings and MUST be overridable per booking.
- **FR-005**: For recurring bookings, users MUST be able to apply their choice to one occurrence or to all future occurrences.
- **FR-006**: The notetaker choice MUST follow a booking when it is rescheduled and MUST be void when the booking is cancelled or rejected.

*Joining and transcribing*

- **FR-007**: System MUST have the notetaker ask to join an enabled, confirmed meeting no later than 1 minute after its scheduled start, using the meeting link current at that moment.
- **FR-008**: System MUST send at most one notetaker to a given booking regardless of how many hosts enabled it.
- **FR-009**: System MUST transcribe the spoken content while the notetaker is in the meeting, attributing each passage to a named participant where identifiable and to a distinct "unknown speaker" label otherwise, with a timestamp per passage.
- **FR-010**: The notetaker MUST leave when the meeting ends, when it is the only participant for 2 minutes, when it is removed or stopped, when it is not admitted within 10 minutes, when no one else joins within 15 minutes of the scheduled start, or after 4 hours of meeting time.
- **FR-011**: System MUST preserve any content captured before an interruption and label it as partial, with the reason.

*Transparency and consent*

- **FR-012**: The notetaker MUST appear under a name that identifies it as an automated notetaker and identifies the host or organization it acts for.
- **FR-013**: The notetaker MUST post a message visible to all participants when it begins transcribing, stating that the meeting is being transcribed, for whom, and how to stop it.
- **FR-014**: System MUST inform attendees before the meeting that it will be transcribed: on the public booking page when the event-type default is on, and by notification when a host enables it for an existing booking.
- **FR-015**: Any participant MUST be able to end transcription by removing the notetaker, and any host MUST be able to stop it from the application; once stopped, the notetaker MUST NOT rejoin that meeting.
- **FR-016**: The notetaker MUST NOT speak, share content, or act in the meeting beyond joining, posting its notice and leaving.

*Results*

- **FR-017**: System MUST save the transcript to the booking it belongs to and make it viewable from that booking.
- **FR-018**: System MUST produce a summary for each transcript containing an overview, key points, decisions and action items, and show it with the transcript on the booking.
- **FR-019**: The summary MUST be written in the language predominantly spoken in the meeting.
- **FR-020**: System MUST notify the host(s) who enabled the notetaker when results are ready; the notification MUST link to the booking and MUST NOT contain the transcript text.
- **FR-021**: Users with access MUST be able to export the summary and transcript as a document.
- **FR-022**: Hosts MUST be able to request the summary again when a transcript exists but its summary is missing or failed.

*Status and failures*

- **FR-023**: System MUST show, on every booking with the notetaker enabled, exactly one current status: scheduled, waiting to be admitted, transcribing, processing, ready, ended early, or failed.
- **FR-024**: For every enabled meeting that ends without a complete transcript, system MUST record and show a specific reason (not admitted, meeting did not start, no speech detected, removed by participant, stopped by host, interrupted, length limit reached, meeting link unusable) and notify the enabling host(s).
- **FR-025**: System MUST prompt the host to admit the notetaker while it is waiting.

*Access, retention and privacy*

- **FR-026**: Transcripts and summaries MUST be visible only to the hosts of the booking unless a host explicitly shares them.
- **FR-027**: Hosts MUST be able to share a booking's transcript and summary with that booking's attendees and to revoke that sharing at any time.
- **FR-028**: Hosts MUST be able to permanently delete a transcript and its summary; deletion MUST remove access for everyone.
- **FR-029**: System MUST retain transcripts and summaries until a host deletes them or until the booking or the owning account is deleted, at which point they MUST be deleted too.
- **FR-030**: System MUST NOT retain the meeting's audio or video after the transcript has been produced.
- **FR-031**: System MUST record who enabled, disabled, stopped, shared, exported and deleted, and when, and make that history visible to hosts.

*Compatibility and presentation*

- **FR-032**: Existing transcription for the application's built-in video meetings MUST continue to behave exactly as it does today; the notetaker MUST NOT be offered for those meetings.
- **FR-033**: Existing integrations that consume booking data or events MUST continue to work without change; anything exposed for this feature MUST be additive.
- **FR-034**: All user-facing text for this feature, including notices sent to attendees, the in-meeting message and the notetaker's status labels, MUST be available in the languages the application supports.

### Key Entities *(include if feature involves data)*

- **Booking** (existing): the scheduled meeting. It anchors the notetaker choice, status, transcript and summary, and has hosts, attendees, a time and a meeting location.
- **Notetaker Choice**: whether the notetaker is on for a booking, who set it and when, and whether it was inherited from the event-type default or applied to a recurring series.
- **Event Type Notetaker Default**: per event type, whether new bookings start with the notetaker on.
- **Notetaker Session**: one attempt by the notetaker to attend one booking's meeting. It holds the status, join and leave times, the outcome reason, and whether it ended early. There is at most one active session per booking.
- **Transcript**: the ordered record of what was said in one session. It belongs to one booking and carries the language, completeness (complete, partial or truncated) and total duration.
- **Transcript Passage**: one continuous utterance, with a speaker label, start time and text.
- **Summary**: derived from one transcript. It holds an overview, key points, decisions and action items (with owner where stated), plus its language.
- **Sharing Grant**: the record that a host has made a booking's transcript and summary visible to its attendees. It is revocable.
- **Activity Record**: who did what and when (enable, disable, stop, share, export, delete).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A host can turn the notetaker on for a booking in under 30 seconds from opening that booking.
- **SC-002**: In at least 95% of enabled meetings, the notetaker has asked to join within 1 minute of the scheduled start.
- **SC-003**: At least 95% of meetings in which the notetaker was admitted result in a complete transcript on the booking.
- **SC-004**: For meetings up to 60 minutes, transcript and summary are available on the booking within 10 minutes of the meeting ending in 95% of cases.
- **SC-005**: In meetings of up to 8 participants, at least 90% of passages are attributed to the correct speaker, measured on a reviewed sample.
- **SC-006**: At least 80% of surveyed hosts rate the summary 4 out of 5 or higher for accurately reflecting the meeting.
- **SC-007**: In 100% of meetings the notetaker joins, its identifying name is visible on entry and its notice is posted within 30 seconds of being admitted.
- **SC-008**: 100% of enabled meetings that yield no complete transcript show a specific reason on the booking within 15 minutes of the scheduled end; there are no silent failures.
- **SC-009**: When any participant removes the notetaker, transcription stops within 10 seconds and the notetaker rejoins in 0% of cases.
- **SC-010**: Access reviews find zero cases of a transcript or summary visible to someone who is neither a host nor an explicitly granted attendee.
- **SC-011**: After release, built-in video transcription and existing integrations show zero behaviour changes.

## Assumptions

- **Eligible meetings:** the notetaker applies to bookings made through this application, the only scheduled meetings the application presents to users today. Selecting events from connected external calendars is out of scope for this specification.
- **Platforms:** Google Meet first, then Microsoft Teams. Zoom and others are out of scope for this specification.
- **Built-in video:** it already has its own transcription, which is unchanged and out of scope.
- **Admission:** the notetaker may be placed in a waiting area; a human participant admitting it is an accepted part of the flow.
- **Consent model:** notice plus the ability to object — advance notice, an identifiable name, an in-meeting message, and removal by any participant. Collecting explicit per-participant consent before transcription starts is out of scope.
- **After an objection or host stop:** content captured so far is kept, labelled, and deletable by hosts.
- **Visibility:** hosts only by default. Sharing is limited to the booking's attendees; public links and sharing with arbitrary third parties are out of scope.
- **Retention:** indefinite until deleted by a host or removed with the booking or account. Configurable retention periods are out of scope.
- **Media:** audio and video recordings are not kept or offered; the deliverable is text.
- **Language:** the transcript is in the language(s) spoken and the summary is in the predominant spoken language. Translation is out of scope.
- **Live view:** transcript and summary are delivered after the meeting; a live in-meeting transcript view is out of scope.
- **Editing:** editing transcript text or speaker names after the fact is out of scope.
- **Limits:** the 10-minute admission wait, 15-minute no-show wait, 2-minute alone timeout and 4-hour maximum are product defaults and may be tuned.
- **Availability and pricing:** which plans or roles may use the notetaker, and any usage limits, are a commercial decision outside this specification. It assumes any user who can host a booking can use it.
- **Authority to enable:** hosts are assumed entitled to invite a notetaker to meetings they host. Organization-level policy controls (such as an administrator disabling the feature) are out of scope for this version.
- **Dependency:** supported meeting platforms continue to allow an automated participant to join as a guest.
