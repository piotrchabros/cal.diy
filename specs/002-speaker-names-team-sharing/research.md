# Research: Notetaker Speaker Names and Team Sharing

**Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Findings come from reading the code at commit `b9ca104` (develop) and from one diagnostic run against a real Google Meet on 2026-10-10 (`meet-probe`, 30 seconds, three participants, nobody spoke). Where a statement rests on that run, it says so.

## Part A: Speaker names

### What happens today

1. The bot mixes all remote audio into one mono stream and sends it to the speech service, which returns text with a diarization label per utterance ("voice 1", "voice 2"). The audio itself carries no identity.
2. `SpeakerAttributor` tries to turn a passage's time window into a participant using two signals, in this order:
   - **Audio source activity**: every 250 ms the page reports which RTP sources (CSRC or SSRC) were audible. To name anyone, a source must first be linked to a participant by a `source_identity` event. **No code emits that event**, so every sample is discarded. This signal has never worked on any platform.
   - **Active speaker in the page**: the adapter reads names inside tiles that contain an element whose `aria-label` contains "speaking". On the real page that label matched 0 times in 51 reads. The run was silent, so this proves only that the label is absent in silence; the meeting of 2026-10-09 had speech and also produced no names.
3. With both signals silent, every passage falls back to a numbered label per diarization voice. The application stores and shows that label unchanged.

Other facts that shape the fix:

- A passage's speaker is final when it is sent (every 5 seconds). The wire contract cannot amend an earlier passage, and the application ignores a resent passage.
- The participant id is derived from the display name (`name:<display name>`), because the page wrapper can read text but not attributes. Two people with the same name therefore merge into one speaker.
- Nothing excludes the notetaker's own tile.
- The diarization label is used only to number unknown speakers. A voice that was named in one passage is not remembered for the next.
- After a speech-service reconnect the labels restart, so one person can become two unknown speakers.
- The transcript shows "Unknown speaker N" while the summary prompt says "Speaker N".
- Measured on the real page: each participant tile holds exactly one visible name (`span.notranslate`), and every tile carries the attributes `data-participant-id` and `data-ssrc`. Values were not recorded. With two other participants the page had four audio receivers, so audio is not one track per participant.

### Decision A1: Measure the real page during speech before choosing the signal

- **Decision**: The first task is a measurement, not code for the product. Extend `meet-probe` to record, per sample and without any names or audio: a salted hash of each tile's `data-participant-id` and `data-ssrc`, the salted hash of each receiver's CSRC and SSRC with its audio level and timestamp, and which tile class tokens toggle. Run it for two minutes in a meeting where two people take turns speaking on a known schedule. The run answers three questions: (Q1) does a tile's `data-ssrc` equal an audio source that becomes active when that person speaks; (Q2) is there a per-tile indicator that tracks speech, and by which attribute or class; (Q3) is the source timestamp on the same clock as `Date.now()`.
- **Rationale**: Both existing signals were built from guesses and both failed. The run of 2026-10-10 could not judge either because nobody spoke. One more guess would repeat the mistake.
- **Alternatives considered**: Build both signals blind and see which works in production (rejected: a wrong name is worse than no name, SC-002). Skip measurement and use captions (rejected below).

### Decision A2: Primary signal is the audio source linked to a tile; the page indicator is second

- **Decision**: Implement `source_identity` for Google Meet by reading `data-participant-id` and `data-ssrc` from each top-level tile on every poll and emitting the link between `ssrc:<n>` (and `csrc:<n>`) and the participant. Keep the page's active-speaker indicator as the second signal, with the selector replaced by what Q2 finds. If Q1 fails and Q2 succeeds, the order flips; if both fail, the transcript falls back to numbered labels and says so (Decision A7). The order stays a constructor option of `SpeakerAttributor`, set per platform.
- **Rationale**: The audio-source path is already implemented and tested in the attributor; only the link is missing. It does not depend on the page language, and it has 250 ms resolution against roughly 600 ms for polling the page.
- **Alternatives considered**:
  - *Live captions*: Meet's captions carry speaker names, but turning them on is an action in the meeting beyond joining, posting the notice and leaving, which FR-016 of the first specification forbids; captions also follow the caption language, not the spoken one.
  - *People panel*: gives a roster but not who is speaking, and requires opening a panel.
  - *One audio stream per participant*: the page does not provide it (four receivers for two remote participants).

### Decision A3: Identify participants by the page's participant id, not by name

- **Decision**: Add one read method to the page wrapper that returns, for each element matching a selector, a fixed list of attribute values and the text of one child selector. The Meet adapter uses it to read `{participantId, ssrc, name, isSelf}` per tile. The speaker key becomes `participant:<salted hash of the participant id>`; the salt is random per session and never leaves the bot. Keys already stored (`unknown:<n>`, `participant:name:<x>`) stay valid because the application treats the key as an opaque string.
- **Rationale**: Required for two people with one name (FR-004), for a renamed participant (same id, new name) and for excluding the notetaker's own tile (FR-005).
- **Alternatives considered**: Keep name-derived ids and add a counter for duplicates (rejected: two tiles with one name cannot be told apart by text alone).

### Decision A4: Remember which voice belongs to which participant

- **Decision**: The attributor keeps, per diarization label, a tally of the participants its passages were confidently attributed to. When a passage cannot be attributed from the signals, and its label has at least 3 confident attributions of which at least 90% name one participant, the passage takes that participant. Otherwise it stays unknown. The thresholds are constructor options.
- **Rationale**: Signals are missing for short passages and overlaps; without this, a meeting would alternate between a name and "Unknown speaker" for the same person, which fails FR-003. The threshold keeps FR-002: one coincidental overlap never names a voice.
- **Alternatives considered**: Propagate after a single match (rejected: a single wrong match would rename every passage of a voice).

### Decision A5: Resolve earlier passages at the end of the meeting

- **Decision**: The bot's final event gains two optional fields: a list of speaker resolutions (`unknown:<n>` now known to be participant P, with P's name) computed from the tally of Decision A4, and a flag saying whether names were available at all. The application applies the resolutions to the stored passages of that transcript before it finalizes and summarizes. Both fields are optional, so an older bot and a newer application, or the reverse, keep working.
- **Rationale**: A voice is often identified only after its first passages were sent. Without a correction step those passages keep a number while later ones carry a name (FR-003). Doing it once, at the end, avoids a general "edit passage" mechanism.
- **Alternatives considered**: Hold passages in the bot until the voice is known (rejected: a crash would lose more text, and the live view would lag). A general amend event (rejected: more surface than needed).

### Decision A6: Display names are made distinct by the bot

- **Decision**: When two participant ids show the same name, the bot sends the second and later ones with a numeric suffix in order of first appearance ("Anna Nowak (2)"). A renamed participant keeps one key; each passage carries the name shown when it was spoken. The summary prompt receives a roster line per speaker key listing every name it used, so the summary treats them as one person.
- **Rationale**: The application has no speaker table and strips the key before data reaches a client; distinct strings are enough for the transcript, the export and the summary. This avoids a new table.
- **Alternatives considered**: A speaker table in the application (rejected for now: more schema for the same visible result).

### Decision A7: Say when names were unavailable

- **Decision**: Store the flag of Decision A5 on the transcript as a nullable boolean (null for transcripts made before this feature). The results page and the export show one sentence when it is false. The bot sets it to false when no participant was ever identified during the session.
- **Rationale**: FR-007 and SC-003.

### Decision A8: One wording for unknown speakers

- **Decision**: The summary prompt uses the same label as the transcript ("Unknown speaker N"), produced from one shared helper.
- **Rationale**: FR-006.

### Decision A9: Microsoft Teams gets the mechanism, not a verified mapping

- **Decision**: The driver method that emits source identities is part of the shared driver interface and optional. Teams does not implement it in this feature; its indicator selector stays as it is and is recorded as unverified. A Teams meeting with no identified participant reports names as unavailable.
- **Rationale**: Teams has never been run against the real service and is not enabled in the deployment (`NOTETAKER_ENABLED_PLATFORMS=GOOGLE_MEET`). FR-007 allows the fallback when it is stated.

### Known limits kept

- People sharing one device appear as one speaker (spec assumption).
- After a speech-service reconnect an unknown voice gets a new number. Decision A4 lets a named voice recover its name; an unknown voice cannot be matched across the reconnect.
- Overlapping speech is labelled unknown when no participant covers at least 60% of the passage.

## Part B: Sharing by event type

### What exists today

- `NotetakerAccessService` decides everything for results: a host of the booking has full access; an attendee has read access when the booking has a sharing grant and one of the user's verified emails is on the attendee list; everyone else is refused. It deliberately has no team or membership dependency, and a test asserts that a team admin with no relation to the booking is refused.
- `EventTypeNotetakerSettings` holds one flag (`enabledByDefault`). It has no sharing fields.
- The settings procedures use `eventOwnerProcedure`, which for a team event type requires the team role ADMIN or OWNER. The permission (PBAC) service elsewhere in this fork is a stub that always answers yes and must not be relied on.
- The bookings list shows a user only bookings where they are organizer or attendee, so a colleague with shared access cannot find a result there.
- The disclosure shown to the booker and the notice posted in the meeting are single fixed texts.
- No notetaker data is exposed through API v2.
- Managed event types are disabled in this fork's editor.

### Decision B1: The sharing mode is stored on the event type's notetaker settings

- **Decision**: Add `sharingMode` (HOSTS_ONLY, TEAM, SELECTED_PEOPLE; default HOSTS_ONLY) to `EventTypeNotetakerSettings`, and a table of selected people keyed by event type and user. The list is kept when the mode is TEAM or HOSTS_ONLY and simply not used.
- **Rationale**: One setting per event type (FR-009); the list survives a mode switch, as the spec's edge case requires.
- **Alternatives considered**: A sharing grant row per booking and member (rejected: membership changes would need writes to every booking, and FR-013 wants access decided at the time of access).

### Decision B2: A meeting is covered only if its participants were told

- **Decision**: When the notetaker is dispatched for a booking whose event type has a sharing mode other than HOSTS_ONLY, the session records `colleagueSharingDisclosed = true` and the in-meeting notice uses the wording that mentions the host's colleagues. Shared access to a result requires both that flag on the result's session and a current sharing mode that includes the viewer.
- **Rationale**: This implements "only meetings held after the change" (FR-015) with the property that matters: nobody outside the hosts reads a meeting whose participants heard the narrower notice. It also gives the right answer for off-then-on: meetings held while sharing was off are never covered, and meetings held while it was on are covered again when it is turned back on.
- **Alternatives considered**: A timestamp on the setting compared with the booking's start time (rejected: turning sharing off and on again would either expose the gap or hide meetings that were disclosed).
- **Consequence**: A booking made while the mode was HOSTS_ONLY and held after sharing was turned on is covered; its booker saw the narrower text at booking time, and the notice in the meeting carries the wider one. The plan accepts this and the settings screen says that sharing applies to meetings held from now on.

### Decision B3: Access is evaluated per request from current membership

- **Decision**: `NotetakerAccessService` gains a third viewer role, `SHARED_VIEWER`, checked after host and attendee. It applies when the session is flagged (B2), the event type belongs to a team, and either the mode is TEAM and the user is an accepted member of that team, or the mode is SELECTED_PEOPLE and the user is on the list and is still an accepted member of the team's organization (or of the team when it has no organization). Membership is read through a narrow lookup port injected into the service.
- **Rationale**: FR-010 to FR-014. No writes are needed when someone leaves.
- **Alternatives considered**: Caching membership in the session (rejected: FR-013 requires the next attempt after removal to fail).

### Decision B4: Shared viewers can read and export, nothing else

- **Decision**: `SHARED_VIEWER` passes the checks that ATTENDEE passes today (state, passages, summary, export). Every mutating operation keeps `assertHost`. The viewer's own feature flag is not required, as for attendees.
- **Rationale**: FR-016, FR-017.

### Decision B5: Who may change the setting

- **Decision**: The get and set procedures for sharing use `eventOwnerProcedure` (team ADMIN or OWNER) and additionally reject event types without a team. The picker's candidates come from a new query on the same guard that searches accepted members of the organization, or of the team when it has no organization. The set operation validates every selected user against the same rule.
- **Rationale**: FR-009, FR-012, FR-025; avoids the stubbed permission service.

### Decision B6: A page for results shared with me

- **Decision**: Add a query that lists results the viewer can read as `SHARED_VIEWER` (newest first, paginated), and a page "Shared with me" under the bookings area that links each row to the existing results page. The query starts from the viewer's accepted team memberships and selected-people rows, so its cost grows with the viewer's teams, not with all bookings.
- **Rationale**: FR-018 and SC-005. The bookings list cannot be reused because it filters by organizer and attendee and its team path is stubbed.
- **Alternatives considered**: Widening the bookings list (rejected: it would also expose booking details, which is beyond this feature).

### Decision B7: Tell hosts who has access, and keep a history

- **Decision**: The state returned to a host gains an access summary: attendee sharing on or off, and the sharing route in force with the team's name or the selected people's names. A new table records each change of mode or of the selected list with actor and time; the activity history of a result merges those changes made since its session was created. The first view by each shared viewer is recorded as a booking activity (`SHARED_VIEWED`).
- **Rationale**: FR-021, FR-023, FR-024.

### Decision B8: Two wordings for the disclosure and the notice

- **Decision**: Add a second translation key for the booker disclosure and for the in-meeting notice, used when the event type's mode is not HOSTS_ONLY. Both say that the transcript and summary may be read by colleagues of the host.
- **Rationale**: FR-022, SC-008.

### Decision B9: Scope limits

- **Decision**: Sharing applies to event types that have a team directly. Managed event types (a child of a team template) are out of scope because this fork's editor disables them. No new feature flag: the existing `notetaker` flag gates the whole feature, and the default mode changes nothing.
- **Rationale**: Smallest change that satisfies the specification.

## Testing approach

- **Bot**: unit tests against `FakeMeetingPage` for the tile read, source identities, voice memory, resolutions, duplicate names, the self tile and the names-unavailable flag. The real-page behaviour is checked by the measurement run (A1) and one live meeting after deployment, recorded in `docs/verification-status.md`.
- **Application**: unit tests for the access matrix (host, attendee, team member, selected person, removed member, undisclosed session, non-team event type), the settings service and the list query, using the in-memory repositories; integration tests for the new repository methods against the scratch database only; handler tests for the new procedures; component tests for the settings control, the access summary and the shared list.
- **E2E**: one new scenario in `apps/web/playwright/notetaker.e2e.ts` (team event type, sharing on, a second member reads the result, an outsider is refused), run against the scratch setup.
