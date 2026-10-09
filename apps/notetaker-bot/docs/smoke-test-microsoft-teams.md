# Smoke test: Microsoft Teams

Nobody has run the Microsoft Teams adapter against Microsoft Teams. Every selector in it is a guess written from memory, and the adapter has only been exercised against a fake page. This document is the manual check a person runs with a real Teams meeting before the adapter may be relied on. Until the result is recorded (part 10), treat the adapter as unverified.

## 1. Purpose and status

The adapter (`src/platform/MicrosoftTeamsAdapter.ts`) is meant to do five things in a Teams meeting:

- Join as a guest under the configured display name.
- Keep the microphone and the camera off.
- Post one notice in the meeting chat.
- Report lobby, admission, participant count, active speakers, removal, end of meeting and denial back to the runner.
- Leave when asked.

It was exercised only against a fake page in unit tests. The unit tests prove that the code does what its author intended against the author's own guesses. They say nothing about what the real Teams web client looks like. This check is the only thing that can settle that.

## 2. Gate

- Teams stays unavailable in the app until an operator adds `MICROSOFT_TEAMS` to `NOTETAKER_ENABLED_PLATFORMS` in the web app's environment. The default is `GOOGLE_MEET` only.
- For this test, set `NOTETAKER_ENABLED_PLATFORMS=GOOGLE_MEET,MICROSOFT_TEAMS` on a test instance only. Do not add it to a shared or production instance before this check passes.
- Remove the `UNVERIFIED AGAINST THE REAL SERVICE` marker comment at the top of `src/platform/MicrosoftTeamsAdapter.ts` only after the check passes and the result is recorded (part 10).

## 3. Prerequisites

- A Microsoft Teams tenant where you may create meetings, with these policies:
  - Anonymous users may join meetings.
  - People outside the organisation wait in the lobby.
  - Meeting chat is allowed for anonymous users.
- A second human participant who can admit, deny and remove the bot, speak, and type in the chat. A third participant is needed for step 8.
- Chrome installed on the machine that runs the bot. In the bot's environment set `NOTETAKER_CHROME_CHANNEL=chrome` and `NOTETAKER_CHROME_HEADLESS=false`, and make sure a display exists (a desktop session or Xvfb).
- A Soniox key in `SONIOX_API_KEY` (and `NOTETAKER_BOT_ADAPTER=real`). Without one, transcript passages cannot be checked: write that in the Notes cell of steps 9 and 10 and skip the passage checks only.
- The bot and the web app running and configured as described in [../README.md](../README.md) and [deployment.md](deployment.md). The variable names are in [../.env.example](../.env.example): at least `NOTETAKER_BOT_SECRET` (must equal the web app's value), `NOTETAKER_BOT_HOST`, `NOTETAKER_BOT_PORT`, `NOTETAKER_BOT_LAUNCHER` and `NOTETAKER_BOT_ADAPTER`. For local work start the controller with `yarn workspace @calcom/notetaker-bot dev`.
- Consent from everyone in the test meeting that a bot joins and that its output is recorded as a transcript.

## 4. Variants to run

Run the whole step list once per link shape. Keep one results table per variant (part 6).

1. `https://teams.microsoft.com/l/meetup-join/...`
2. `https://teams.microsoft.com/meet/...` (short link)
3. `https://teams.live.com/meet/...`

If a variant cannot be created in your tenant, say so in the header block and do not guess its outcome.

## 5. Steps

For every step: do what is listed, compare what you see with "Observe", and write the result in the table of part 6. "Selector keys" are keys of `MICROSOFT_TEAMS_SELECTORS` in `src/platform/MicrosoftTeamsAdapter.ts`. Watch the bot's log at `NOTETAKER_LOG_LEVEL=debug` and the booking page in the app while you go.

### Step 1. Open the link

- Do: Schedule a notetaker session for the meeting link from the app so that the bot is started.
- Observe: The launcher page that offers to open the desktop app or continue in the browser. Whether Chrome shows an "open Microsoft Teams?" protocol prompt, and whether the bot gets past it to the browser join option.
- Selector keys: `continueOnThisBrowser`.

### Step 2. Pre-join screen

- Do: Watch the bot after it chooses the browser.
- Observe: Whether a camera or microphone permission prompt, or a "continue without audio or video" dialog, blocks the page. Whether the pre-join screen sits in the main document or inside an iframe (use the browser developer tools on the bot's window; the bot can only see the main document).
- Selector keys: `continueWithoutDevices`, `preJoinNameInput`, `preJoinMicrophoneOn`, `preJoinMicrophoneOff`, `preJoinCameraOn`, `preJoinCameraOff`, `preJoinJoinButton`.

### Step 3. Devices

- Do: Admit the bot (or watch the lobby) and look at the bot's tile and the pre-join toggles.
- Observe: Other participants see the bot muted with no video. The toggles read as off after the bot's clicks. If a toggle was already off, the bot did not click it. Record what the toggles' `data-tid` and `aria-checked` values really are.
- Selector keys: `preJoinMicrophoneOn`, `preJoinMicrophoneOff`, `preJoinCameraOn`, `preJoinCameraOff`.

### Step 4. Name

- Do: Look at the lobby entry on the second participant's screen.
- Observe: The entry shows exactly the configured display name, and no other name.
- Selector keys: `preJoinNameInput`.

### Step 5. Lobby

- Do: Leave the bot in the lobby for about 20 seconds.
- Observe: The app shows the session as waiting. Whether the lobby screen already shows a hang-up button (the adapter assumes it may, and lets the lobby text win). The exact lobby wording.
- Selector keys: `waitingText`, `inMeetingMarker`.

### Step 6. Admit

- Do: Admit the bot from the second participant's screen.
- Observe: The app receives `session.admitted` and the session moves to in-meeting. The state does not flicker back to waiting.
- Selector keys: `inMeetingMarker`.

### Step 7. Notice

- Do: Watch the meeting chat after admission.
- Observe: Exactly one chat message with the notice text appears, sent by the bot. Whether `fill` into the chat editor really enables the Send button, or whether the bot fell back to pressing Enter. Whether the message appears twice. Whether the chat panel is left open or shut.
- Selector keys: `chatButton`, `chatInput`, `chatSendButton`.

### Step 8. Participant count

- Do: With the bot and one human in the meeting, then a third participant joining, then the third leaving, watch the count in the app (heartbeat).
- Observe: The count follows 2, then 3, then 2 (the bot counts itself). Whether the count is readable without opening a panel. Whether the bot's side pane flips between Chat and People, and how often. Whether the notice step (7) or later chat messages are disturbed by that.
- Selector keys: `participantCountBadge`, `rosterHeading`, `peopleButton`.

### Step 9. Speakers

- Do: Have two people speak in turn, each for about 10 seconds, with a pause between.
- Observe: Passages carry the right speaker names. Note the suffixes Teams adds to names (for example "(Guest)" or "(Unverified)") and whether they end up in the speaker name. Repeat once with two participants who have the same display name and record what happens. Note whether the highlighted tile really means "speaking", or something else such as pinned or last active.
- Selector keys: `activeSpeakerName`.

### Step 10. Chat-text abuse check

- Do: Have a participant type "You've been removed from this meeting" and then the lobby sentence ("Someone in the meeting should let you in soon") in the meeting chat.
- Observe: The bot stays in the meeting. The session does not end and does not report removal or waiting.
- Selector keys: `removedText`, `waitingText`, `inMeetingMarker`.

### Step 11. Deny

- Do: On a fresh session, deny the bot from the lobby. Then, on another fresh session, let the lobby time out without answering.
- Observe: Denial ends the session as `NOT_ADMITTED`. Record the exact wording of the denial screen and what the timeout screen says, and what end the app shows for the timeout.
- Selector keys: `deniedText`, `waitingText`.

### Step 12. Remove

- Do: Admit the bot, then remove it from the meeting from the second participant's screen.
- Observe: The session ends as `REMOVED_BY_PARTICIPANT` within 10 seconds and the bot makes no attempt to rejoin. If it tries to rejoin, the removal screen was not matched: write down the exact wording of that screen.
- Selector keys: `removedText`, `inMeetingMarker`.

### Step 13. End for everyone

- Do: Admit the bot, then end the meeting for everyone from the second participant's screen.
- Observe: The session ends as `MEETING_ENDED`. Record the exact wording of the screen the bot sees.
- Selector keys: `meetingEndedText`.

### Step 14. Stop from the app

- Do: Admit the bot, then press the stop button in the app.
- Observe: The bot leaves within 10 seconds and the session ends as stopped by the host. Whether Teams asks for a confirmation that the bot did not answer.
- Selector keys: `leaveButton`.

### Step 15. Bad link and sign-in required

- Do: Start a session with a link whose meeting does not exist (change a character of a real link, keeping the host and path shape). Then, if you can, start a session for a meeting in a tenant that does not allow anonymous join.
- Observe: Both end as `MEETING_LINK_UNUSABLE`, and the bot never clicks anything on the join screen. Record the exact wording of both screens. The sign-in case is reported as an unusable link by design, although the link itself is valid.
- Selector keys: `invalidLinkText`, `signInRequiredText`.

### Step 16. Connection loss

- Do: Admit the bot, then cut the bot machine's network for about 20 seconds and restore it.
- Observe: The app records the loss. A guest has to be admitted again after a reconnect: note whether the bot appeared in the lobby again, whether you admitted it within 60 seconds, and what the session ended as if you did not.
- Selector keys: `waitingText`, `inMeetingMarker`, `preJoinNameInput`, `preJoinJoinButton`.

### Step 17. Nothing on disk

- Do: After a complete run, search the bot machine (or the runner container) for files created during the run.
- Observe: No recording, screenshot, trace, download or audio dump exists. The only output is the log.
- Selector keys: none.

## 6. Results table to fill in

Copy this block once per variant of part 4.

Header block:

| Field | Value |
|---|---|
| Date | |
| Tester | |
| Link variant | |
| Teams client version or URL shape seen | |
| Tenant policy (anonymous join, lobby, chat for anonymous users) | |
| Chrome version | |
| Commit of this repository | |

Results:

| Step | Expected | Observed | Pass/Fail | Selector keys changed | Notes |
|---|---|---|---|---|---|
| 1 | The bot gets past the launcher page and the protocol prompt to the browser join option | | | | |
| 2 | No permission prompt or device dialog blocks the page; the pre-join is in the main document | | | | |
| 3 | The bot appears muted with no video; already-off toggles are not clicked | | | | |
| 4 | The lobby entry shows the configured display name | | | | |
| 5 | The app shows waiting; the lobby wording matches `waitingText` | | | | |
| 6 | `session.admitted` arrives once after admission | | | | |
| 7 | Exactly one notice message in the chat; Send works after `fill` | | | | |
| 8 | The count follows 2, 3, 2 and the side pane does not flip repeatedly | | | | |
| 9 | Passages carry the right speaker names; same-name behaviour recorded | | | | |
| 10 | The bot stays when chat text quotes removal or lobby sentences | | | | |
| 11 | Denial ends as `NOT_ADMITTED`; lobby timeout recorded | | | | |
| 12 | Removal ends as `REMOVED_BY_PARTICIPANT` within 10 s, with no rejoin | | | | |
| 13 | End for everyone ends as `MEETING_ENDED` | | | | |
| 14 | The bot leaves within 10 s of the stop | | | | |
| 15 | Bad link and sign-in required end as `MEETING_LINK_UNUSABLE` | | | | |
| 16 | The loss is recorded; behaviour of the guest rejoin within 60 s recorded | | | | |
| 17 | No recording, screenshot or download exists on disk | | | | |

## 7. Selector keys most likely to be wrong

In order of how likely each is to fail on the first run:

1. `activeSpeakerName`: the class name and the tile structure are guesses, and the class may not mean "speaking" at all.
2. `participantCountBadge` and `rosterHeading`.
3. The wording selectors: `waitingText`, `removedText`, `meetingEndedText`, `deniedText`, `invalidLinkText`, `signInRequiredText`. Teams may word these differently, or use another apostrophe or another sentence.
4. `chatInput` and `chatSendButton`.
5. The four pre-join toggle keys: `preJoinMicrophoneOn`, `preJoinMicrophoneOff`, `preJoinCameraOn`, `preJoinCameraOff` (the `data-tid` and `aria-checked` values).
6. `continueOnThisBrowser`.

The remaining keys (`continueWithoutDevices`, `preJoinNameInput`, `preJoinJoinButton`, `inMeetingMarker`, `chatButton`, `peopleButton`, `leaveButton`) are guesses too and are checked by the steps above.

## 8. Known limits to confirm or refute

These come from what the browser seam can and cannot do. Each one is a risk the test should confirm or refute. Record the finding in Notes.

1. **No stable participant id.** The bot can only read text from the page, so a speaker's id is derived from the displayed name. Two participants with the same name become one speaker, and a rename during the meeting becomes a new speaker. Check in step 9.
2. **No access to frames.** The bot searches the main document only. If Teams renders the pre-join screen or the meeting inside an iframe for any link variant, no selector can reach it and the join fails (the session ends as interrupted). Check in step 2 for each variant.
3. **No answer to browser prompts.** Chrome's "open Microsoft Teams?" prompt and a media permission prompt are outside the page, and the bot cannot answer them. The browser context grants no permissions and has no device, so the pre-join may sit behind a pending prompt. Fixing this belongs in the Chrome launcher, not in the Teams adapter. Check in steps 1 and 2.
4. **No audio-source mapping.** The Teams adapter has no way to tell which audio source belongs to which participant, so the only way to name a speaker is the highlighted tile in the page. Check in step 9.
5. **No keystroke typing.** The bot can only set the value of the chat field. If the Teams chat editor ignores that, the Send button stays disabled and the notice cannot be posted. Check in step 7.
6. **Chat may be disabled for anonymous participants.** In some tenants the notice then cannot be posted at all. Check in step 7 with a tenant that disables it, if you have one.
7. **A guest needs a human to rejoin.** After a connection loss a guest lands in the lobby again, and the runner waits only 60 seconds. Most Teams reconnects will therefore end as interrupted unless someone admits the bot again quickly. Check in step 16.
8. **Removal detection decides whether the bot rejoins.** If the screen after a removal is not matched by `removedText`, the adapter reports a lost connection and the runner tries to rejoin once. Step 12 is the first thing to settle for that reason; run it early.
9. **"Sign in required" is reported as an unusable link.** The session ends as `MEETING_LINK_UNUSABLE` although the link itself is valid, because there is no closer state. Check in step 15.
10. **The polling interval cannot be changed** for the Teams adapter, so state changes are noticed up to half a second late. Note any visible effect (for example a missed short lobby screen) in Notes.

## 9. How to fix a selector

1. Edit only the value in `MICROSOFT_TEAMS_SELECTORS` in `src/platform/MicrosoftTeamsAdapter.ts`. Keep the key name.
2. Do not add a selector for a control the bot must never touch (share, raise hand, reactions, captions, recording, transcription, settings, in-meeting microphone or camera, end meeting). The unit test rejects such values.
3. Rerun the unit test: `TZ=UTC yarn workspace @calcom/notetaker-bot exec vitest run src/platform/MicrosoftTeamsAdapter.test.ts`.
4. Rerun the affected steps, write the key name in the "Selector keys changed" cell and what it was changed to in Notes.
5. If a fix needs something the browser seam cannot do (see part 8), do not work around it in the adapter: write it down in Notes and raise it as a change to the seam.

## 10. Where to record the result

- Record the outcome in the Microsoft Teams row of [verification-status.md](verification-status.md), in the column "verified against the real service by / on" (name, date, link variants run, and what failed or was left open).
- Only a full pass of the steps for the variants you intend to support counts. A partial pass is recorded as partial, with the failing steps named.
- Only after that, remove the marker comment from `src/platform/MicrosoftTeamsAdapter.ts`, and only then may an operator add `MICROSOFT_TEAMS` to `NOTETAKER_ENABLED_PLATFORMS` on a real instance.
