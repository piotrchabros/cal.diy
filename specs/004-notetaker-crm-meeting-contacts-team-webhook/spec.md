# Feature Specification: Meeting Contacts and the Team Webhook for the CRM

**Feature Branch**: `004-notetaker-crm-meeting-contacts-team-webhook` (code on `feat/notetaker-crm-webhook`, same worktree as `specs/003`)

**Created**: 2026-11-06

**Status**: Implemented (uncommitted in `/root/cal.diy-crm-webhook`; PR split in plan.md)

**Input**: Phase 2 of the CRM integration. User decisions: (1) a team webhook receives only meetings shared with that team through cal.diy's notetaker sharing, nothing else; (2) approved schema: new table `NotetakerMeetingContact` with its enum and a `Booking` back-relation, and the column `Webhook.includeMemberMeetings` defaulting to false; (3) the admin/owner requirement and "do not attach the creating user" apply only to webhooks with the new flag, existing team webhooks are unchanged.

**Builds on**: `specs/001-meeting-transcription` (notetaker, ad-hoc meetings, calendar auto-join), `specs/002-speaker-names-team-sharing` (sharing modes, the colleague notice), `specs/003-notetaker-crm-transcript-webhook` (the transcript webhook; amended by this feature). Terms keep their meaning from those specifications. "Meeting without an event type" means an ad-hoc meeting or a calendar auto-join meeting.

**Companion change**: Open Mercato `@open-mercato/webhook-calcom` (unassigned-transcripts inbox, staff filter, `source`), spec `.ai/specs/2026-11-04-calcom-crm-integration.md`, phase 2 section.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A host names the customers of an ad-hoc meeting (Priority: P1)

A host pastes a meeting link into the notetaker's "Add to meeting" dialog. Before starting the bot they can type the customers' email addresses. The addresses go only to the CRM with the transcript; nobody is emailed, nobody gains access to the results, and the meeting does not appear in anyone else's bookings. After the meeting the CRM attaches the transcript to the matching person.

**Why this priority**: Without a customer address the CRM cannot tell whose meeting a transcript belongs to; today ad-hoc meetings carry no attendee at all.

**Independent Test**: Add a meeting with two customer emails, finish it, and check the transcript webhook carries exactly those two attendees and that no email was sent to them.

**Acceptance Scenarios**:

1. **Given** the dialog with "Customer emails (optional)" filled with two valid addresses, **When** the host starts the bot, **Then** the meeting stores the two contacts and the later transcript webhook lists them as attendees.
2. **Given** an invalid address or more than 20 addresses, **When** the host submits, **Then** the dialog shows the matching message and does not start the bot.
3. **Given** the host typed their own address, a duplicate, or mixed case, **When** saved, **Then** the own address is dropped, duplicates collapse, and addresses are stored lowercase.
4. **Given** a stored contact, **When** the meeting runs, **Then** the contact receives no attendee notice, no shared-results email, cannot open the results and does not see the booking.
5. **Given** an ad-hoc or calendar meeting, **When** the host opens its booking page, **Then** a "Customer emails" editor shows the stored contacts (calendar ones labelled "From calendar invite") and lets the host replace the manually entered ones.
6. **Given** the transcript was already delivered, **When** the host edits the contacts, **Then** the editor says the changes will not be re-sent, and saves them anyway.
7. **Given** a booking made through an event type, **When** someone calls the contacts mutation for it, **Then** it is refused ("only ad-hoc or calendar meetings").
8. **Given** a user who is not a host of the meeting, **When** they call the contacts mutation, **Then** it is refused.

---

### User Story 2 - Calendar invitees become contacts automatically (Priority: P2)

When the notetaker joins a meeting from the host's Google or Office 365 calendar, the invitees of that calendar event are stored as contacts, with the names the calendar knows, so the CRM can match them without any typing.

**Why this priority**: Calendar auto-join is the hands-off path; asking the host to type addresses again defeats it.

**Independent Test**: Auto-join a calendar event with three invitees, one of whom is a cal.diy colleague and one a meeting room; check the stored contacts are the remaining invitee plus the external organizer, with names.

**Acceptance Scenarios**:

1. **Given** a calendar event with invitees and names, **When** the sweep creates the meeting, **Then** contacts are stored for each invitee email with the calendar's display name.
2. **Given** invitees that are the host (any verified address), other cal.diy participants of the same meeting, or meeting rooms, **When** stored, **Then** they are left out.
3. **Given** the event organizer is not the host, **When** stored, **Then** the organizer is a contact too.
4. **Given** the invite list changes before the meeting ends, **When** the host's calendar is swept again, **Then** the calendar contacts are replaced; manual contacts stay.
5. **Given** a participant other than the owner is swept, or the meeting has ended, **When** their calendar shows the event, **Then** the contacts are not touched.
6. **Given** more than 50 invitees, **When** stored, **Then** only the first 50 remaining are kept.
7. **Given** storing fails, **When** the sweep continues, **Then** the meeting is still created or updated and a warning with ids only is logged.

---

### User Story 3 - A team admin connects the whole team with one webhook (Priority: P1)

A team admin creates one team webhook and turns on "Include meetings of all team members". From then on that webhook receives booking events, meeting started/ended events and transcripts for every meeting a member shares with this team through notetaker sharing, and nothing else. The webhook belongs to the team, not to the admin who created it.

**Why this priority**: Per-user webhooks need every host to configure the CRM secret; one team webhook does it once.

**Independent Test**: Create a flagged team webhook; have a member hold a meeting shared with the team and another meeting set to hosts only; check only the first reaches the webhook.

**Acceptance Scenarios**:

1. **Given** a team admin or owner on the new-webhook page for a team, **When** they open the form, **Then** the switch is shown and can be turned on.
2. **Given** a plain member on the same page, **When** they open the form, **Then** the switch is shown disabled with the note "Only team admins and owners can change this setting", and the server refuses the flag if sent anyway.
3. **Given** the flag is set at creation, **When** the webhook is stored, **Then** it has no owning user.
4. **Given** a webhook of an organization, a platform webhook, a user webhook or an event-type webhook, **When** the flag is requested, **Then** the request is refused.
5. **Given** a member's booking whose notetaker sharing is "whole team T", **When** it is created, rescheduled, requested, cancelled or rejected, or its meeting starts or ends, **Then** the flagged webhook of T receives the event alongside the member's own subscribers.
6. **Given** a member's booking set to hosts only or selected people, or shared with another team, or whose owner is no longer an accepted member of T, **When** any of those events happens, **Then** the flagged webhook of T is not called.
7. **Given** a meeting shared with T whose colleague notice was shown, **When** its transcript settles, **Then** the flagged webhook of T receives it (`specs/003` US2).
8. **Given** a team webhook without the flag, **When** any of the above happens for a member's personal booking, **Then** its behaviour is exactly as before this feature.
9. **Given** the flag is turned on for an existing active team webhook, **When** saved, **Then** meeting started/ended rows are scheduled for the members' future shared bookings; turning it off removes them.
10. **Given** a flagged (ownerless) team webhook, **When** a plain member tries to open, edit, test or delete it, or lists webhooks, **Then** it is refused or hidden; admins and owners of that team can.
11. **Given** a flagged or ownerless team webhook, **When** an edit tries to move it to another team or to an event type, **Then** it is refused.

---

### Edge Cases

- A flagged webhook keeps `userId` null even after the flag is turned off again, so it does not silently become the editing admin's personal webhook.
- Deleting a webhook that cannot be found as the caller's own and is not an ownerless team webhook the caller administers now answers "not found" (before: silently returned the id).
- The booking owner's time zone and locale are used for every attendee of the meeting payload, because contacts carry neither.
- Contacts of a booking are deleted with the booking (cascade).
- The same email stored as CALENDAR cannot be added again as MANUAL (unique per booking); it keeps its calendar row and name.
- Dynamic (no-id) event types never match a team.
- Payment events are not covered (see plan, known gaps). Seated bookings are covered through the subscriber options passed from `RegularBookingService`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let a host attach up to 20 customer email addresses to a meeting without an event type, at creation (ad-hoc dialog) and later (booking page), replacing the previous manual set each time.
- **FR-002**: Contacts MUST NOT be booking attendees: no notice or results email, no access to results, no visibility in bookings lists, no effect on guests.
- **FR-003**: The system MUST store the invitees of a calendar auto-join event as calendar contacts with their names, from the meeting owner's calendar only, while the meeting has not ended, up to 50, excluding the owner's addresses, other cal.diy participants of the meeting, the host as organizer, and meeting rooms.
- **FR-004**: Contact addresses MUST be normalized (trimmed, lowercase, valid email, deduplicated) and MUST NOT be logged.
- **FR-005**: Transcript webhooks of meetings without an event type MUST carry the contacts as attendees and the owner as organizer (`specs/003` contract v2).
- **FR-006**: A team webhook MAY opt into member meetings; the option MUST be available only for a team that is not an organization, not platform, not bound to an event type, and MUST be set or changed only by an admin or owner of that team.
- **FR-007**: A webhook with the option MUST belong to the team (no owning user); its team and event type MUST NOT be changeable; reading, editing, testing, deleting and listing it MUST be limited to admins and owners of its team.
- **FR-008**: A flagged webhook of team T MUST receive an event for a booking only when the booking's notetaker sharing scope resolves to "whole team T" and the owner is an accepted member of T; hosts-only and selected-people meetings MUST never reach it.
- **FR-009**: The events covered MUST be booking created, rescheduled, requested, cancelled, rejected, meeting started, meeting ended and the transcript; for the transcript the colleague notice MUST have been shown and the results not deleted.
- **FR-010**: Turning the option on or off for an active webhook MUST add or remove the scheduled meeting started/ended rows of the members' future shared bookings; creating a flagged webhook MUST schedule them.
- **FR-011**: Webhooks without the option MUST behave exactly as before.

### Key Entities

- **Meeting contact**: email, optional name, source (`MANUAL` by the host, `CALENDAR` from the invite), unique per booking and email, deleted with the booking.
- **Webhook**: gains the boolean "include member meetings", default off.
- **Member sharing team**: the single team a booking's results are shared with, derived at event time from the event type's notetaker settings (or the ad-hoc metadata) and current membership.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of transcript webhooks for ad-hoc meetings with at least one contact carry that contact; the CRM matches the person without manual work (verified by unit tests of the payload builder and the gateway).
- **SC-002**: No contact ever receives an email or can open results (verified by the absence of any attendee row: the only email and access paths read `Attendee`).
- **SC-003**: A flagged team webhook receives 0 events for hosts-only or selected-people meetings and 1 per covered event for team-shared meetings (verified by unit tests for every sender and for the subscriber query).
- **SC-004**: Existing team webhooks pass their existing tests unchanged.
- **SC-005**: A plain member cannot read the secret of a flagged team webhook through any tRPC procedure (verified by handler tests).

## Assumptions

- The user approved the two schema changes (table plus enum plus back-relation; one boolean column).
- `MembershipRepository.getAdminOrOwnerMembership` is the single source of truth for "team admin or owner".
- The CRM applies its own staff filter (drops attendees that are CRM users) on top of what cal.diy sends.
- The cron on `/api/cron/webhookTriggers` from `specs/003` is in place for MEETING_* rows.

## Known gaps (accepted, see plan.md)

- Scheduled MEETING_STARTED/ENDED rows of a flagged webhook are not removed when a member later leaves the team or sharing for the event type is turned off; transcripts are unaffected because their scope is re-checked at send time.
- Existing (unflagged) team webhooks are untouched, including the pre-existing issue that every accepted member can read a user-owned team webhook, secret included, because `WebhookRepository`'s `PermissionCheckService` is a stub that allows everything. Flagged as follow-up.

## Changelog

- 2026-11-06: initial version, written after implementation to document the delivered behaviour.
