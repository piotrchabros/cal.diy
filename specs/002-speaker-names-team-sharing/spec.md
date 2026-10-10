# Feature Specification: Notetaker Speaker Names and Team Sharing

**Feature Branch**: `002-speaker-names-team-sharing`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "1. naprawic rozpoznawanie mowcow 2. w przypadku zespolow powinna byc mozliwosc dzielenia podsumowaniami i transkrypcjami z innymi uzytkownikami. widze to na dwa sposoby - albo wspoldzielenie ze wszystkimi w ramach tego samego zespolu, albo wybieranie uzytkownikow z organizacji w ustawieniach spotkania ktorym chcemy wspoldzielic wszystkie nagrania."

**Builds on**: `specs/001-meeting-transcription` (the notetaker). Terms such as host, booking, notetaker, transcript, summary and sharing grant keep their meaning from that specification.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Transcript passages carry the names of the people who spoke (Priority: P1)

A host opens the transcript of a meeting in which several people spoke. Today every passage reads "Speaker 1", "Speaker 2", so the host has to work out from the content who said what. After this change each passage shows the name the participant had in the meeting, and the summary's decisions and action items name people the same way.

**Why this priority**: A transcript without names is hard to use and makes action items unassignable. The first specification already promised named speakers (FR-009, SC-005); the live service does not deliver it.

**Independent Test**: Hold a meeting with at least three participants who each speak in turn, then open the transcript and check that each passage carries the name of the person who actually spoke.

**Acceptance Scenarios**:

1. **Given** a transcribed meeting in which three participants spoke one at a time, **When** the host opens the transcript, **Then** each passage shows the name that participant had in the meeting.
2. **Given** a participant who spoke at several separate times, **When** the host reads the transcript, **Then** all of that participant's passages carry the same name.
3. **Given** a passage whose speaker could not be determined with confidence, **When** the host reads the transcript, **Then** the passage shows a numbered unknown-speaker label, never another participant's name.
4. **Given** an unknown speaker who spoke several times, **When** the host reads the transcript, **Then** all of that speaker's passages carry the same numbered label.
5. **Given** a transcript with named speakers, **When** the summary is generated, **Then** its decisions and action items refer to people by the same names as the transcript.
6. **Given** a transcript with named speakers, **When** a host exports it, **Then** the exported document carries the same names.

---

### User Story 2 - Share every result of a team event type with the whole team (Priority: P2)

A team admin opens the settings of a team event type and chooses that the notetaker's results for this event type are shared with the whole team. From then on every team member can open the transcript and summary of any meeting booked through that event type, without the host sharing each one by hand.

**Why this priority**: In a team, the people who need a meeting's notes are usually colleagues, not only the person who hosted. Today only the hosts and, on request, the attendees can read them.

**Independent Test**: Turn team sharing on for one team event type, hold a transcribed meeting hosted by one member, and confirm that another team member who was not in the meeting can read the results while a person outside the team cannot.

**Acceptance Scenarios**:

1. **Given** a team event type with team sharing on, **When** a transcribed meeting held after it was turned on produces results, **Then** every current member of that team can view the transcript and summary.
2. **Given** the same results, **When** a signed-in person who is not a member of the team and has no other access tries to open them, **Then** access is refused.
3. **Given** a team member with access through team sharing, **When** they are removed from the team, **Then** their next attempt to open those results is refused.
4. **Given** a person who joins the team after a meeting was transcribed under team sharing, **When** they open that meeting's results while team sharing is on, **Then** they can view them.
7. **Given** results of a meeting held before team sharing was turned on, **When** a team member who is not a host tries to open them, **Then** access is refused.
5. **Given** a team admin turns team sharing off, **When** a team member who had access only through it next tries to open any result of that event type, **Then** access is refused.
6. **Given** a team member who has access through team sharing, **When** they look at their bookings list, **Then** they can find and open the shared results without being given a link.

---

### User Story 3 - Share every result of an event type with selected people (Priority: P2)

A team admin opens the settings of a team event type and picks specific people from the organization, for example a sales lead and a customer-success manager, who should see every result of this event type. Those people can read the transcripts and summaries; the rest of the team cannot.

**Why this priority**: Some meetings (hiring, sales, client escalations) should be visible to a few named people, not to a whole team. It is an alternative to User Story 2 for the same need.

**Independent Test**: Select two people on one team event type, hold a transcribed meeting, and confirm that exactly those two people, the hosts, and any attendees the host shared with can read the results.

**Acceptance Scenarios**:

1. **Given** a team event type with two selected people, **When** a transcribed meeting booked through it produces results, **Then** those two people can view the transcript and summary.
2. **Given** the same event type, **When** a team member who is not selected and is not a host of the booking tries to open the results, **Then** access is refused.
3. **Given** a selected person is removed from the list, **When** they next try to open any result of that event type, **Then** access is refused.
4. **Given** a selected person leaves the organization, **When** they next try to open any result, **Then** access is refused without anyone editing the list.
5. **Given** a team admin choosing people, **When** they search, **Then** only members of the same organization (or of the same team, when the team belongs to no organization) can be chosen.

---

### User Story 4 - Everyone can see who has access (Priority: P3)

A host opens the results of one of their meetings and sees a plain statement of who can read them: the hosts, the attendees (if shared), the whole team, or the named selected people. A person the meeting was booked with learns, before and during the meeting, that the notes may be read by the host's colleagues.

**Why this priority**: Wider sharing is only acceptable when it is visible. It protects hosts from surprises and keeps the notice given to attendees truthful.

**Independent Test**: Turn team sharing on for an event type, book a meeting as an outside attendee, and check that the booking information and the in-meeting notice say that the host's team may read the notes; then open the results as the host and check that the access statement lists the team.

**Acceptance Scenarios**:

1. **Given** results covered by team sharing, **When** a host opens them, **Then** they see that the whole team has access and the name of the team.
2. **Given** results covered by selected-people sharing, **When** a host opens them, **Then** they see the names of the selected people.
3. **Given** an event type with sharing beyond the hosts configured, **When** someone books it with the notetaker on, **Then** the information shown to the booker states that the transcript and summary may be read by the host's colleagues.
4. **Given** a team admin changes the sharing setting of an event type, **When** a host later opens the activity history of a result, **Then** the change, who made it and when are listed.

---

### Edge Cases

- **Two participants share one display name.** They are kept apart as two speakers and shown with a distinguishing suffix; their passages are not merged under one name.
- **A participant changes their display name during the meeting.** Passages keep the name the participant had when each passage was spoken; the two names are not presented as two different people in the summary where the system can tell they are the same participant.
- **Several people speak at once.** A passage whose speaker cannot be determined with confidence is labelled unknown rather than given to whoever was most recently speaking.
- **Several people share one device (a meeting room).** They appear under the name of that participant; telling room occupants apart is out of scope.
- **The notetaker's own account.** It never appears as a speaker and is never listed as a participant in the summary.
- **A participant never speaks.** They do not appear as a speaker; no empty passages are created for them.
- **Transcripts made before this change.** They keep their numbered labels; they are not relabelled.
- **Sharing mode switched off and on again.** Meetings held while it was off are not covered when it is turned back on.
- **A host deletes a result that was shared with the team.** Deletion removes access for everyone, as today.
- **An event type is moved to another team or stops being a team event type.** Team sharing follows the current team; when there is no team any more, sharing by team stops.
- **A selected person is also a host or an attendee.** They keep whatever access they have by those other routes when removed from the list.
- **Results of meetings hosted by a member who dislikes the setting.** The host cannot override the event type's sharing for one booking in this version, but can delete the result.
- **Both sharing modes at once.** An event type has exactly one sharing mode at a time; choosing the whole team hides the list of selected people without discarding it.

## Requirements *(mandatory)*

### Functional Requirements

*Speaker names*

- **FR-001**: System MUST attribute each transcript passage to the name the speaking participant showed in the meeting, whenever the speaker can be determined with confidence.
- **FR-002**: System MUST label a passage with a numbered unknown-speaker label when the speaker cannot be determined with confidence, and MUST NOT attribute it to a named participant by guess.
- **FR-003**: System MUST use one consistent name or label for the same speaker throughout a transcript.
- **FR-004**: System MUST keep two participants with the same display name apart as distinct speakers.
- **FR-005**: System MUST NOT present the notetaker itself as a speaker or as a participant.
- **FR-006**: The summary and the exported document MUST use the same speaker names as the transcript.
- **FR-007**: Speaker naming MUST work for every platform on which the notetaker is offered; where a platform cannot provide names, the transcript MUST fall back to numbered labels and the results page MUST say that names were unavailable for that meeting.
- **FR-008**: System MUST NOT change the speaker labels of transcripts created before this feature.

*Sharing by event type*

- **FR-009**: For a team event type, people allowed to manage that event type MUST be able to set one sharing mode for the notetaker's results: hosts only (default), whole team, or selected people.
- **FR-010**: With the whole-team mode, every current member of the team that owns the event type MUST be able to view the transcript and summary of every booking of that event type.
- **FR-011**: With the selected-people mode, every currently selected person MUST be able to view the transcript and summary of every booking of that event type, and no other team member gains access by that mode.
- **FR-012**: People selectable in the selected-people mode MUST be limited to members of the organization that the team belongs to, or to members of the team itself when it belongs to no organization.
- **FR-013**: Access granted by a sharing mode MUST be evaluated at the time of each access: a person who has left the team, left the organization, or been removed from the list MUST be refused from then on.
- **FR-014**: Changing or turning off the sharing mode MUST take effect for all results of that event type on the next access attempt.
- **FR-015**: A newly chosen sharing mode MUST apply only to results of meetings held after the change; results that already existed MUST keep the access they had, and the settings screen MUST say so.
- **FR-016**: Access granted by a sharing mode MUST be read-only: such people can view and export, and MUST NOT be able to delete results, change sharing, stop the notetaker or change whether it joins.
- **FR-017**: Sharing by event type MUST NOT reduce or replace existing access: hosts keep full access, and a host's sharing with the booking's attendees keeps working independently.
- **FR-018**: People with access through a sharing mode MUST be able to find the shared results from within the application without being sent a link.
- **FR-019**: A person with no access by any route MUST be refused, and the refusal MUST NOT reveal whether results exist.
- **FR-020**: Deleting a result MUST remove access for everyone, including people with access through a sharing mode.

*Transparency and history*

- **FR-021**: The results page MUST state who currently has access and by which route (host, attendee sharing, whole team with the team's name, or the selected people by name).
- **FR-022**: When an event type shares results beyond the hosts, the information given to the person booking and the notice the notetaker posts in the meeting MUST state that the transcript and summary may be read by the host's colleagues.
- **FR-023**: System MUST record every change of an event type's sharing mode and of its selected people, with who made it and when, and MUST show these changes in the activity history of the affected results.
- **FR-024**: System MUST record each first view of a result by a person whose access comes from a sharing mode, visible to hosts in the activity history.
- **FR-025**: Sharing by event type MUST be available only where the notetaker itself is available, and MUST be hidden for event types that do not belong to a team.

### Key Entities

- **Speaker**: one participant of a meeting as heard in the transcript. It has a display name when known, otherwise a numbered unknown label, and it is distinct per participant even when names collide.
- **Transcript Passage** (existing): gains a reliable link to the speaker who said it.
- **Event Type Sharing Setting**: the sharing mode of one team event type (hosts only, whole team, selected people) with who last changed it and when.
- **Selected Person**: one member of the organization (or team) named on an event type's selected-people list.
- **Access Route**: the reason a person may view a result: host, attendee sharing grant, team sharing, or selected person. A person may hold several.
- **Activity Record** (existing): gains entries for sharing-mode changes, list changes and first views by people with shared access.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In meetings of up to 8 participants where people speak one at a time, at least 90% of passages carry the correct participant's name, measured on a reviewed sample of at least 10 meetings.
- **SC-002**: Across the same sample, fewer than 2% of passages are attributed to a wrong named participant; uncertain passages are labelled unknown instead.
- **SC-003**: In a meeting of at least three speaking participants, no transcript shows only numbered labels unless the results page states that names were unavailable.
- **SC-004**: A team admin can turn on whole-team sharing or select people for an event type in under 1 minute, without leaving the event type's settings.
- **SC-005**: A team member with shared access can find and open a shared result from their own account in under 30 seconds, without a link.
- **SC-006**: After a person is removed from the team, the organization or the selected list, their next access attempt is refused in 100% of tested cases.
- **SC-007**: Access reviews find zero cases of a transcript or summary visible to someone who is not a host, a granted attendee, a current team member under whole-team sharing, or a currently selected person.
- **SC-008**: For every booking of an event type that shares beyond the hosts, the booker's information and the in-meeting notice mention that colleagues of the host may read the notes, in 100% of tested cases.

## Assumptions

- **One specification, two parts.** Speaker names (User Story 1) and sharing (User Stories 2 to 4) are independent and can be planned, built and released separately.
- **Both sharing modes are offered (confirmed 2026-10-10).** The description names two ways of sharing; this specification offers both as alternative modes of one setting per event type, with hosts only as the default so nothing changes until an admin chooses.
- **Team event types only.** Sharing by event type applies to event types owned by a team. Personal event types keep today's rules (hosts, plus attendees when shared).
- **Who configures.** Whoever may already manage the team event type's settings (team owners and admins) sets the sharing mode; ordinary members cannot.
- **"Recordings" means transcripts and summaries.** The notetaker keeps no audio or video, and this feature does not add any.
- **Read-only shared access.** People who gain access through a sharing mode can view and export but not delete, re-share or control the notetaker.
- **No per-booking override.** A host cannot exclude one booking from the event type's sharing in this version; deleting the result remains possible.
- **No external sharing.** Public links and sharing with people outside the organization or team remain out of scope.
- **Names come from the meeting.** A speaker's name is the display name the participant had in the meeting; it is not matched to application accounts, and editing names afterwards remains out of scope.
- **One device, one speaker.** People sharing a single device or room system are treated as one participant.
- **Existing transcripts are untouched.** Old transcripts keep their numbered labels.
- **Sharing is not retroactive (confirmed 2026-10-10).** A sharing mode covers meetings held after it was chosen, because participants of earlier meetings were told a narrower audience.
- **Dependencies.** Requires the notetaker from `specs/001-meeting-transcription` to be deployed, and the existing team and organization membership records as the source of truth for who belongs where.
