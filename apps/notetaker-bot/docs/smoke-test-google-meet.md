# Manual check against Google Meet, Chrome and Soniox

## 1. Status

Nothing in this document has been run by the people who wrote the code. Every command, expected result and selector below comes from documentation, memory and the source files, and none of it has been tried against Google Meet or Chrome. The Soniox provider was run on 2026-10-09 against the real Soniox service with a sample audio file only (see the register), not in a meeting. Read "expected" as "expected (unconfirmed)". The register that records results is [verification-status.md](verification-status.md). It is empty until a person fills it in after this check (section 10).

Where a name, route or behaviour below could not be confirmed in the repository, the text says so and tells you to confirm it first.

## 2. What this check covers

One real meeting, joined by the bot as a guest, covers six files. Each starts with the marker comment that points here.

| File | What you must observe |
|---|---|
| `src/audio/captureScript.ts` | Step 0 (`scripts/capture-smoke.ts`) produces frames. In the real call, passages follow what people say, and the page console shows no Content Security Policy or Trusted Types error. |
| `src/stt/sonioxProtocol.ts` | Soniox accepts the start message and returns tokens the code can read. No protocol error in the bot log. |
| `src/stt/SonioxRealtimeProvider.ts` | Passages arrive with plausible text, language and times, and a long silence or a reconnect does not break the stream. |
| `src/platform/browser/PlaywrightChromeLauncher.ts` | Chrome opens through channel `chrome`, the page loads, clicks and typing reach the page, closing the page ends cleanly. |
| `src/platform/browser/BrowserPlatformAdapter.ts` | State changes reach the app in order: waiting, admitted, count, removed or ended. The reconnect path works once. |
| `src/platform/GoogleMeetAdapter.ts` | Every selector in section 9 matches the real page, and the join, notice, count, speaker and leave steps in section 7 behave as listed. |

Out of scope: speaker attribution rules ([speaker-attribution-spike.md](speaker-attribution-spike.md)), Microsoft Teams, and the Docker image ([deployment.md](deployment.md)).

## 3. Before you start

- Host a throwaway Google Meet meeting yourself. At least two other people must join, and they must have agreed to be transcribed. Do not use a real business meeting.
- Account mode (section 8) needs the owner's answer to research.md open question 3 (who owns the bot's Google account, and whether automating it is acceptable) before you run it. Guest mode does not.
- Google Chrome installed (channel `chrome`) and a display, or `xvfb-run` on a machine without one.
- A Soniox API key.
- Either the web app running with the notetaker feature switched on, or the hand-signed request in section 7. The name of the switch that turns the feature on for a host was not confirmed on disk. Confirm it in the app before you rely on the app route.
- Nobody may record the bot's machine screen while the check runs, and no meeting content may be copied into tickets or the register.

## 4. Environment

Bot side. Copy the names from `apps/notetaker-bot/.env.example`. Do not commit the file.

| Variable | Value for this check |
|---|---|
| `NOTETAKER_BOT_SECRET` | a long random string you generate; the app must use the same value |
| `NOTETAKER_BOT_HOST` | `127.0.0.1` |
| `NOTETAKER_BOT_PORT` | `4010` |
| `NOTETAKER_BOT_LAUNCHER` | `child_process` |
| `NOTETAKER_BOT_ADAPTER` | `real` (not `fake`) |
| `SONIOX_API_KEY` | your key |
| `SONIOX_WS_URL`, `SONIOX_MODEL` | leave empty to use the built-in defaults |
| `NOTETAKER_GOOGLE_JOIN_MODE` | `guest` (account values are in section 8) |
| `NOTETAKER_GOOGLE_STORAGE_STATE_B64`, `NOTETAKER_GOOGLE_ACCOUNT_EMAIL`, `NOTETAKER_GOOGLE_ACCOUNT_PASSWORD` | empty in guest mode |
| `NOTETAKER_CHROME_CHANNEL` | `chrome` |
| `NOTETAKER_CHROME_HEADLESS` | `false` |
| `NOTETAKER_LOG_LEVEL` | `debug` |

App side, in the web app's environment:

| Variable | Value |
|---|---|
| `NOTETAKER_BOT_PROVIDER` | `self_hosted` |
| `NOTETAKER_BOT_URL` | `http://127.0.0.1:4010` |
| `NOTETAKER_BOT_SECRET` | the same value as on the bot |
| `NOTETAKER_ENABLED_PLATFORMS` | `GOOGLE_MEET` |

The four app-side names are read in `packages/features/notetaker/lib/config.ts`.

The app must also be able to receive the bot's events at `{WEBAPP_URL}/api/notetaker/events`. If the bot runs on the same machine, `WEBAPP_URL` must be reachable from it.

## 5. Step 0: capture smoke

Run from the repository root:

```bash
yarn workspace @calcom/notetaker-bot tsx scripts/capture-smoke.ts
```

To use the installed Chrome instead of the Playwright Chromium, prefix the command with `NOTETAKER_CHROME_CHANNEL=chrome`. The script header says it keeps no audio and writes no file. It runs for about five seconds.

Expected (unconfirmed): it prints a non-zero number of frames and a non-zero number of samples for the five-second window, and exits with status 0. I could not confirm the exact lines it prints without running it, so read the output against the counter names in the script (`frames`, `samples`, `nonSilentFrames`, `rejectedPayloads`, `activityCalls`, `activitySources`).

| Observation | Result |
|---|---|
| Exit status | |
| Frames in five seconds | |
| Non-silent frames | |
| Rejected payloads (expected 0) | |
| Chrome version | |

Evidence for `src/audio/captureScript.ts` and `scripts/capture-smoke.ts`. Stop here if it fails. The later steps depend on it.

## 6. Step 1: start the bot

Load the bot environment from section 4 into your shell, then start the controller. The README gives:

```bash
yarn workspace @calcom/notetaker-bot dev
```

That script runs `src/main.ts`. At the time this document was written, `src/main.ts` and `src/runnerMain.ts` did not exist in the tree. They come with the composition unit. Until that lands, there is nothing to start. Check that the files exist before you go on.

Check the controller:

```bash
curl http://127.0.0.1:4010/healthz
```

Expected (unconfirmed): status 200 and a body shaped like `{"ok":true,"activeSessions":0,"capacity":10}`. This shape is from `src/server.ts`. A 503 with `{"ok":false}` means the controller is not usable.

| Observation | Result |
|---|---|
| `/healthz` status and body | |

## 7. Step 2: guest join

### Trigger

Route A, through the app:

1. Create a booking whose location is your Meet link, and switch the notetaker on for it. Confirm in the app how that is done. The exact UI path was not confirmed here.
2. Run the sweep. The route is `GET /api/cron/notetaker` in `apps/web/app/api/cron/notetaker/route.ts`. It answers 401 unless the `authorization` header equals the `CRON_API_KEY` value or `Bearer ` plus the `CRON_SECRET` value, or the same text is passed as the `apiKey` query parameter:

```bash
curl -H "authorization: $CRON_API_KEY" http://localhost:3000/api/cron/notetaker
```

The sweep only dispatches sessions that are due. Check the lead time (`NOTETAKER_JOIN_LEAD_SECONDS`, default 120 in `config.ts`) against your meeting start time.

Route B, a hand-signed request to the bot:

- Endpoint: `POST /v1/sessions` on `http://127.0.0.1:4010`.
- Headers, as named in `packages/lib/notetaker/botContract.ts`: `X-Notetaker-Timestamp` is the Unix time in seconds as a decimal string. `X-Notetaker-Signature` is `sha256=` followed by the hex HMAC-SHA256, keyed with `NOTETAKER_BOT_SECRET`, of the string `<timestamp>.<raw body>`. The body in the signed string must be byte for byte the body you send. The bot accepts a timestamp within 300 seconds of its own clock.
- Body: the fields in `specs/001-meeting-transcription/contracts/bot-control-api.md` (`sessionId`, `platform` set to `GOOGLE_MEET`, `meetingUrl` set to `<meeting link>`, `displayName`, `noticeMessage`, `scheduledStartAt`, `callbackUrl`, `limits`). Use the example in that file as the shape, with your own values.
- `callbackUrl` must point at an events receiver that accepts signed events. If you have no app running, `yarn workspace @calcom/notetaker-bot fake-events --help` describes a tool that posts events to the app, but it does not receive them. Without a receiver you can still watch the bot log and the Meet window, but you cannot check the events in the checklist.
- A 202 answer with `sessionId` and `externalRef` means the request was accepted. 401 `invalid_signature` means the signature or the clock is wrong.

### Runner behaviour you need to know first

These are as the runner was built. A wrong guessed selector can end every real session, so they matter when you read the results:

- If the notice is not posted within 30 seconds of admission, the bot leaves and the session ends `INTERRUPTED`. Posting is tried at +0, 5, 10, 15, 20 and 25 seconds. No transcript passage is sent before the notice is posted. So a wrong `chatButton`, `chatInput` or `chatSendButton` selector ends the session.
- If a participant count above 1 is never read, the session ends `MEETING_DID_NOT_START` at the no-show deadline. So a wrong `participantCountBadge` and `participantTile` pair ends the session.
- The driver sends the notice and then checks that the chat composer is empty again. An empty composer is its sign that the send went through. It does not show the text in the chat, so you still confirm that by looking.
- A thrown read becomes `connection_lost` in the adapter, and one reconnect is tried.
- Meet needs a reply from a person. Be ready to admit the bot within the admission timeout (default 600 seconds).

Seen 2026-10-10 (Linux, Chrome 155, bot account invited as a calendar guest): Meet shows an embedded Google Chat in a child iframe, not in the main frame. The composer is `div[role="textbox"][contenteditable="true"]`, and it takes about 3 to 4 seconds to render after the chat toggle click. Do not match it by its aria-label, which reads "History is on" and reflects a setting. The send control is `button[aria-label="Send message"]`, disabled while the composer is empty. `chatInput` and `chatSendButton` cover this variant and the classic `textarea`. `chatPanelOpen` reads the toggle's `aria-expanded`, so a retry does not close the panel that is already open.

### Checklist

Fill the result column as you go. Write "pass", "fail" or "not seen", and a short note. Do not paste meeting content, links or names.

| # | Observation | Evidence for | Result |
|---|---|---|---|
| 1 | Chrome opens. No profile directory, download or recording file is created. | `PlaywrightChromeLauncher.ts` | |
| 2 | Under the context's empty permission list, Meet shows its "continue without microphone and camera" dialog (expected, unconfirmed), and the bot dismisses it. | `GoogleMeetAdapter.ts` | |
| 3 | Microphone and camera show as off before the request to join, and stay off for the whole call. | `GoogleMeetAdapter.ts` | |
| 4 | The name typed in the guest field equals the request's `displayName`. | `GoogleMeetAdapter.ts` | |
| 5 | The host sees the request under that name, and the app shows waiting (`session.waiting`). | `GoogleMeetAdapter.ts`, `BrowserPlatformAdapter.ts` | |
| 6 | After the host admits the bot, `session.admitted` reaches the app within about a second. | `BrowserPlatformAdapter.ts` | |
| 7 | The notice appears in the Meet chat exactly once, with the exact text, and `session.notice_posted` arrives. | `GoogleMeetAdapter.ts` | |
| 8 | The participant count in the heartbeat equals the number of people in the call including the bot, and follows joins and leaves. | `GoogleMeetAdapter.ts` | |
| 9 | Passages arrive with plausible text, language and times. | `captureScript.ts`, `sonioxProtocol.ts`, `SonioxRealtimeProvider.ts` | |
| 10 | The page console shows no Content Security Policy or Trusted Types error. Note any you see. | `captureScript.ts` | |
| 11 | Speakers are named, or labelled "Speaker N". Two participants who use the same display name are merged into one (known limit, section 11). | `GoogleMeetAdapter.ts` | |
| 12 | The bot does not present, raise a hand, react, switch captions on, record or open settings. | `GoogleMeetAdapter.ts` | |
| 13 | Second run, host denies the request: session ends `NOT_ADMITTED`. | `GoogleMeetAdapter.ts`, `BrowserPlatformAdapter.ts` | |
| 14 | Third run, host leaves the request unanswered: write down the text Meet shows, and the outcome. | `GoogleMeetAdapter.ts` | |
| 15 | Host removes the bot from the call: `REMOVED_BY_PARTICIPANT` within 10 seconds, and no rejoin. | `GoogleMeetAdapter.ts`, `BrowserPlatformAdapter.ts` | |
| 16 | Stop from the app: the bot leaves within 10 seconds. | `GoogleMeetAdapter.ts` | |
| 17 | Host ends the call for everyone: `MEETING_ENDED`. | `GoogleMeetAdapter.ts` | |
| 18 | Everyone else leaves: `ALONE_TIMEOUT` after the alone timeout (default 120 seconds). | `GoogleMeetAdapter.ts` | |
| 19 | A link with a code that does not exist: `MEETING_LINK_UNUSABLE`. | `GoogleMeetAdapter.ts` | |
| 20 | Cut the bot's network or close its Chrome tab: one `session.reconnecting`, one new request to join, no second notice. | `BrowserPlatformAdapter.ts`, `GoogleMeetAdapter.ts` | |
| 21 | Afterwards no audio, video, trace or image file exists anywhere on the machine. | `workspaceRules` claim, whole workspace | |

Event and outcome names above are from the build plan and the contract. If the app shows different names, write down what it shows.

## 8. Step 3: account join

Run this only with the owner's approval (section 3). The default and the recommended mode for this check is guest.

Account mode has three parts: prepare a Google account for the bot, capture a signed-in session from it, and make sure Meet lets the bot in without a person admitting it. Nothing in the three subsections below has been run against Google by the people who wrote it.

### Preparing the bot's Google account

1. Create a dedicated Google account for the bot. A Google Workspace account on your own domain is preferred over a personal account. Do not use a person's account.
2. Set a recovery email address and a recovery phone number on the account, so you can get back in if Google challenges a sign-in.
3. Set the account's language to English (US). The bot's selectors are English text.
4. Sign in to the account once by hand in a normal browser and accept every first-login prompt Google shows.
5. Decide what the account's profile name should say. In account mode the meeting shows the ACCOUNT's name, not the per-host display name the app sends with the request. Requirement FR-012 (`specs/001-meeting-transcription/spec.md`) covers this case: the account's name must say it is an automated notetaker and name the organization that operates it, and the host is named by the notice the bot posts and by the advance notice the app sends. Choose the profile name accordingly.
6. Automating a Google account is subject to Google's terms, and Google may challenge or block it. Whether that is acceptable is the owner's decision; see `specs/001-meeting-transcription/research.md`, open question 3.

### Capturing the signed-in session

1. Run the script on your own machine, not on a server. It needs a display and a person to sign in. Use a checkout where dependencies are already installed. Nothing extra is installed: the workspace already depends on `playwright`, and channel `chrome` uses the Google Chrome installed on the machine, not a Playwright browser download.
2. If Chrome is not installed, the script prints a line saying Google Chrome was not found for the channel, exits with status 1 and writes nothing. Install Chrome, or set `NOTETAKER_CHROME_CHANNEL` to the channel the bot uses, and run it again.
3. Run it in one of two ways:
   - `yarn workspace @calcom/notetaker-bot capture-google-state` prints the value for `NOTETAKER_GOOGLE_STORAGE_STATE_B64` on standard output and nothing else. The instructions go to standard error, so you can pipe the value straight to the clipboard with `| pbcopy`, `| wl-copy` or `| xclip -selection clipboard`.
   - `yarn workspace @calcom/notetaker-bot capture-google-state --out "$HOME/notetaker-google-state.json"` writes the session to a file instead and prints nothing on standard output. Then encode it on one line with `base64 -w0 <file>` (macOS: `base64 -i <file>`) and delete the file.
4. `--out` must be an absolute path to a file that does not exist yet. The script refuses to overwrite a file. It creates the file with mode 0600.
5. Chrome opens on Google's sign-in page. Sign in to the bot's account, including any two-step challenge, then press Enter in the terminal. Ctrl+C closes the browser and writes nothing.
6. Before it writes anything, the script checks three things: the browser holds a Google session cookie (it looks at cookie names only), the Google account page loads without redirecting to sign-in, and Google Meet's home page stays on `meet.google.com` without showing a sign-in link. If it cannot confirm all three, it says which check failed, exits with a non-zero status and writes nothing.
7. Paste the value into `NOTETAKER_GOOGLE_STORAGE_STATE_B64` in `apps/notetaker-bot/.env` and set `NOTETAKER_GOOGLE_JOIN_MODE=account`.
8. The value is a credential. Treat it like a password: keep it out of tickets, shared logs, the register and git. Clear it from your terminal scrollback. The bot's `.env` is git-ignored.
9. Sessions expire. When that happens the bot refuses to join instead of joining anonymously (observation 6 below; the session ends as interrupted), and you must repeat the capture.
10. Open and unverified: Google may refuse the sign-in in a Chrome window started by automation ("This browser or app may not be secure" is widely reported), and the script adds nothing to work around that. A session captured on one machine and replayed from the bot's machine may also be challenged. Record what happens in observation 11.

The script has not been run by the people who wrote it. It has its own row in [verification-status.md](verification-status.md).

### Letting the bot in without the waiting room

1. Invite the bot account's email address to the calendar event as a guest.
2. What the invitation changes is taken from other meeting-bot vendors' documentation. We have tested none of it:
   - A signed-in account that is on the invite is normally let straight in. (Observed on 2026-10-09, see verification-status.md.)
   - A signed-in account that is not invited still asks to join, and someone must admit it. (Observed on 2026-10-09, see verification-status.md.)
   - Meetings whose host settings restrict access to invited people refuse an anonymous guest outright, which is the refusal the owner saw. (Reported in other meeting-bot vendors' documentation; not verified by us.)
3. The application adds the bot's email address to the booking's Google Calendar event itself, about two minutes before the meeting, when `NOTETAKER_GOOGLE_ACCOUNT_EMAIL` is set in the application's environment (not the bot's) and the Meet link was created by the application on that event. It does not do so for a pasted Meet link, for a booking whose calendar it cannot write to, or when the variable is empty; invite the account by hand in those cases, or admit it. For a check started with a hand-signed request (route B) there is no booking, so invite it by hand.

### Join mode and what to observe

Set `NOTETAKER_GOOGLE_JOIN_MODE=account` and use one of these routes.

Storage-state route:

1. On your own machine, sign in to the bot's Google account in a Playwright browser and save its storage state as a JSON file.
2. Encode it on one line: `base64 -w0 <state file>`.
3. Put the output in `NOTETAKER_GOOGLE_STORAGE_STATE_B64` and delete the JSON file. The bot decodes it in memory and does not write it.

The script in "Capturing the signed-in session" does steps 1 and 2 for you, or step 1 only when you pass `--out`.

Password route:

- Set `NOTETAKER_GOOGLE_ACCOUNT_EMAIL` and `NOTETAKER_GOOGLE_ACCOUNT_PASSWORD`. The account must have no two-step verification. A challenge, a captcha or a wrong password is expected to fail with `Google sign-in stalled at step completion`.

Both routes:

- The account's interface language must be English (US). The selectors are English text.
- Never put the state, the password or the account email in a ticket, a log you share, or the register.

| # | Observation | Result |
|---|---|---|
| 1 | The bot appears in the call under the ACCOUNT's name, not the request's `displayName`. | |
| 2 | Exactly one log line says the display name cannot be applied in account join mode. | |
| 3 | No name is typed on the join screen. | |
| 4 | Meet offers "Join now" or "Ask to join" (write down which). | |
| 5 | After a reconnect (close the tab), sign-in runs again, and the display-name warning is not repeated. | |
| 6 | An expired storage state ends in a refusal to join (`Google Meet shows a guest join screen although account join mode is configured`), not an anonymous join. | |
| 7 | Password route with a challenge: the session fails at `Google sign-in stalled at step completion`. | |
| 8 | Account mode, the bot's email address invited to the event. Write down whether the bot joined directly or asked to join. | |
| 9 | Account mode, the bot not invited. Write down whether it asked to join or was refused. | |
| 10 | Guest mode against a meeting restricted to invited people. Write down the text Meet shows and the outcome the app shows. | |
| 11 | The capture script. Write down whether Chrome opened, whether Google accepted the sign-in in that window, whether the script's check passed, and whether the bot started with the value. | |

## 9. Selectors to re-check

Keys are the 31 keys of `GOOGLE_MEET_SELECTORS` in `src/platform/GoogleMeetAdapter.ts`. The selector strings there are guesses written from memory. Open Meet's developer tools on the real page and check each one against what you see. Fill the last two columns. If the file does not exist yet when you read this, the keys below are the intended set and must be compared with the file.

Every alternative of every selector ends in `:visible`. This is because the page wrapper takes the first DOM match with `.first()`, and a hidden element earlier in the page would otherwise hide a visible one. Check that `:visible` after `:text(...)` works in a comma list in Playwright 1.57. This is not confirmed.

Order is by risk. A wrong key near the top ends sessions.

| Key | Purpose | Matched the page | Correction |
|---|---|---|---|
| `inMeetingMarker` | controls that exist only inside the call; first test of admission | | |
| `participantCountBadge` | number next to the people button | | |
| `participantTile` | one match per participant tile; fallback for the count. The driver also reads its `data-participant-id` and `class` attributes (speaker names); the tile and the two class tokens were seen on the real page on 2026-10-10 | | |
| `chatButton` | opens the chat panel | | |
| `chatPanelOpen` | the chat toggle with `aria-expanded="true"`; read only, never clicked | | |
| `chatInput` | chat text field | | |
| `chatSendButton` | sends the notice | | |
| `waitingText` | text while waiting for admission | | |
| `deniedText` | request refused, unanswered, or guests not allowed | | |
| `removedText` | removed by a participant | | |
| `endedText` | meeting over; includes "You left the meeting" as a guess | | |
| `linkInvalidText` | unusable link | | |
| `activeSpeakerName` | name inside a tile that carries the sustained speaking class token (`BlxGDf`); not read by the driver, swept by the probe only, so a renamed token shows as zero matches during speech | | |
| `turnOffMicrophone` | pre-join microphone toggle while on | | |
| `turnOffCamera` | pre-join camera toggle while on | | |
| `microphoneSettled` | pre-join microphone control in its final state ("Microphone problem" indicator, or the muted toggle via `data-is-muted="true"`); waited for before the turn-off check | | |
| `cameraSettled` | same for the camera ("Camera problem" indicator, or the muted toggle) | | |
| `guestNameInput` | guest name field | | |
| `askToJoinButton` | request entry | | |
| `joinNowButton` | enter without a request | | |
| `switchHereButton` | rejoin while a lingering connection of the same account is in the call; takes its place; "Join here too" is deliberately not used (button tag unverified) | | |
| `joinScreenOrVerdict` | composite: the page settled after load | | |
| `leaveCallButton` | leaves the call | | |
| `dialogContinueWithoutDevices` | device-permission dialog | | |
| `dialogGotIt` | information dialog | | |
| `dialogDismiss` | information dialog | | |
| `signInEmailInput` | Google sign-in, email field | | |
| `signInEmailNext` | Google sign-in, next after email | | |
| `signInPasswordInput` | Google sign-in, password field | | |
| `signInPasswordNext` | Google sign-in, next after password | | |
| `signedInMarker` | sign-in finished; avatar on the Meet landing page | | |

Also note, for each text key, the exact wording Meet shows in your interface language, so the guess can be corrected.

The leave control (`leaveCallButton`) is the open one; section 12 runs a probe that records what the real page shows for it. The speaker indicator was measured on 2026-10-10 (see [speaker-attribution-spike.md](speaker-attribution-spike.md), section 11): the speaking class tokens are configuration in `GOOGLE_MEET_SPEAKING_INDICATORS`, not selector strings, and they were read by the probe, not by the bot in a real session.

## 10. Recording the result

Do this per file, for the six files in section 2, in [verification-status.md](verification-status.md). That file may not exist yet when you read this. Create the rows only if it has been added.

For each file, fill the column "verified against the real service by / on" with:

- who ran the check and the date,
- the Chrome version,
- the Meet interface language,
- the join mode (guest or account),
- what failed, if anything.

Rules:

- A file loses its three-line marker comment only if every check for it passed. A partial result keeps the marker and is written in the row: what was confirmed, what remains.
- When a marker is removed, delete that file's path from `MARKED_FILES` in `src/workspaceRules.test.ts` in the same change. Rule 5 of that test fails otherwise.
- Corrections to selectors go into `src/platform/GoogleMeetAdapter.ts` in a separate change, not in the register.
- No credential, meeting link or participant name goes into the register, a ticket or a commit message.

## 11. Known limits and open points

- The leave click is still open after the 2026-10-09 check; section 12 is the probe that diagnoses it. Speaker names were measured on 2026-10-10 by the probe; whether the bot names speakers in a real meeting is not yet checked (specification 002 task T049).
- Speaker ids come from the tile's `data-participant-id`, read by `readParticipants` through the page wrapper's `readElements`. That Meet gives two participants with one display name different ids, and that a renamed participant keeps the id, are assumed, not measured. `readParticipants` and `readElements` have run against fakes only.
- The page does not say which audio source belongs to which tile (the tile's `data-ssrc` never equalled a source), so no `source_identity` event is emitted. The bot learns the link from the instantaneous tile indicator, and the sustained indicator is the second signal. The link rule and its thresholds have been run against fakes only. T175 is only partly done: more than two speakers and SC-005 are not measured.
- Google may detect and block automated browsers. This was not tested.
- Google's terms for automating an account are an open question for the owner (research.md open question 3).
- An organisation can block guests. Such a meeting ends as `NOT_ADMITTED`.
- The notice is sent, and the driver treats an emptied composer as the sign that it went through. Only a person looking at the chat can confirm the text appeared.
- The participant count cannot be read if Meet puts it only in an `aria-label`. The wrapper has no attribute read.
- The page wrapper has no wait for hidden, no wait for one of several, and no sleep. The driver uses a composite selector instead.
- The runner decisions D1, D2 and D3 of the build plan await the owner. D1 as built leaves when the notice cannot be posted, which is stricter than the plan's text. Confirm which one the owner wants.

## 12. Meet probe: the leave click and the speaker names

Nothing in this section has been run by the people who wrote it. The probe (`scripts/meet-probe.ts`) has not been executed, not even once.

### What it is for

The 2026-10-09 check left two defects open that nobody can diagnose without seeing the real page. First, on a stop request the leave click failed and the bot left by closing the browser. Second, speakers were labelled "Speaker N" and never named. The probe joins a meeting the way the bot does, records what the page shows around the leave control and the participant tiles while people talk, tries the bot's own leave routine at the end, and writes one JSON file. You run it once and send that file back.

### Before you start

- The same shell environment as the account-mode bot run in section 8: `NOTETAKER_GOOGLE_JOIN_MODE=account` with either `NOTETAKER_GOOGLE_STORAGE_STATE_B64` or both `NOTETAKER_GOOGLE_ACCOUNT_EMAIL` and `NOTETAKER_GOOGLE_ACCOUNT_PASSWORD`, and `NOTETAKER_CHROME_CHANNEL=chrome`, `NOTETAKER_CHROME_HEADLESS=false`. The probe reads these names from the process environment and loads no `.env` file, so export them in the shell you run it from. It needs no Soniox key and no bot secret.
- Google Chrome installed, on your macOS laptop.
- A throwaway Google Meet meeting that you host, with at least two other people who will talk in turn.
- The bot's Google account invited to the event, or ready to be admitted by you (section 8).

**Tell the other participants before the call starts.** A diagnostic tool joins as a participant. Tell them what it records and what it does not: it records the structure of the Meet page (element names, labels, positions, which tile is marked as speaking) and audio levels as numbers. It records no audio, no video, no screenshots and no chat. Unless you pass `--no-notice`, it also posts a one-line notice in the meeting chat after it is admitted, saying that a diagnostic tool is in the call.

### Command

Run from the repository root:

```bash
yarn workspace @calcom/notetaker-bot meet-probe "<meeting-url>" --out "$HOME/meet-probe.json"
```

| Option | Meaning | Default |
|---|---|---|
| `--out <file>` | Where to write the report. Required. Must be an absolute path to a file that does not exist yet; it is created with mode 0600. | none |
| `--duration <seconds>` | How long to observe after admission, 10 to 600. | 60 |
| `--interval-ms <ms>` | Time between page samples, 250 to 5000. | 1000 |
| `--admit-timeout <seconds>` | How long to wait to be admitted, 10 to 1800. | 300 |
| `--redact-names` / `--no-redact-names` | Replace participant names with `Participant A`, `Participant B` and so on, or keep them as they appear. Giving both is an error. | redaction on |
| `--no-notice` | Do not post the notice in the chat. | notice posted |

The probe appears in the meeting under the bot account's name (account mode ignores the display name, section 8). Press Ctrl+C to end the observation early; the probe still leaves and writes the file.

### What to do in the call

Admit the probe if it asks to join. The observation window starts after admission, so a slow admission does not use it up; the probe waits up to the admit timeout. Then follow this script for the default 60 seconds:

| Seconds | What happens |
|---|---|
| 0 to 10 | Nobody speaks. |
| 10 to 25 | Person A speaks alone. |
| 25 to 40 | Person B speaks alone. |
| 40 to 50 | A and B speak at the same time. |
| 50 to 60 | Silence. |

After 60 seconds the probe leaves by itself. Watch the call window and note whether the probe's tile disappears immediately when it leaves, or only after the browser closes a few seconds later. You add that observation by hand (see "Sending the file back").

### What the terminal prints

At the end the probe prints a summary on standard output: a "Leave" block with one line per hypothesis L1 to L6, a "Speakers" block with S1 to S7 and a "Speech measurement" block with Q1 to Q3, each marked supported, excluded or inconclusive with one sentence of evidence, then the path of the file to send back. On standard error it prints how the run ended and that the report was written. The exit status is 0 when the window ran to its end, 130 when you ended it with Ctrl+C, and 1 for anything else (denied, removed, meeting ended, connection lost, not admitted in time, join failed, or a refusal to write).

### What the file contains

- Per sample, at the interval: the candidate leave controls (role, accessible name, `aria-label`, title, tooltip, `data-*` attribute names, visibility, enabled state, bounding box, what is at its centre, whether it is in a dialog); the participant tiles with every string they show and where it appears (text, `aria-label`, title or tooltip), class tokens and attribute changes; counts for a few speaker selectors; the page's WebRTC audio receivers with contributing and synchronization sources and their audio levels; whether the tab is visible and focused.
- Match counts of the selectors the adapter uses (matched and visible).
- The platform events the adapter produced, a count of audio frames and non-silent frames, and every page call the adapter made, with timing.
- The leave routine step by step: the state before it, what the adapter logged, and what the page showed for up to 3 seconds after it.
- A table of the name aliases and where each appeared.
- The run's settings and facts: join mode, credential route (a word, not a value), Chrome channel and headless flag, platform, Node version, the meeting host (`meet.google.com`) and the start time.

- `measurements`: the verdicts Q1 to Q3 with their counts (schemaVersion 2 of the report).

It does not contain audio, video, screenshots, recordings, cookies, storage state, credentials, the meeting URL or code, or chat text. Tiles are numbered `tile-1`, `tile-2` and so on, never by Meet's participant id. Participant ids and audio sources (both the ones on the tiles and the ones the page's receivers report) are identified only by the first 16 hex characters of a salted SHA-256. The salt is random for each run and is never written, so a hash cannot be turned back into an id and files from two runs cannot be joined.

### Names and the limits of redaction

With the default redaction, every word taken from the page is kept only if it is a generic Meet interface word; names become `Participant A`, `Participant B` and so on, the same alias each time, and the file still shows where each name appeared. This is a best effort, not a guarantee. A name that is also an ordinary interface word, or a string the probe did not recognise as a name, can survive; a word the probe does not recognise is replaced with `<x>` rather than kept. **Before you send the file, search it for each participant's name (first name, surname, nickname) and for the meeting code.** If one is there, remove it from the file or ask for it to be handled before sending.

The probe checks its own output before writing: if it finds the meeting URL, the meeting code, the account email, the password, the storage state, the probe's salt, a raw participant id, a raw audio source id or (with redaction on) a raw participant name in the JSON, it prints which kind of item was found, writes nothing and exits with status 1. The file is deleted. Run it again; if it refuses again, send the author the kind of item it names, not the item.

### Sending the file back

Send `meet-probe.json` to the developers by the same private route you use for the register. Add one line by hand: whether the probe's tile disappeared the moment it left. Do not send anything else from the call.

### Two-minute speech measurement

A second protocol uses the same probe to measure whether a tile's source id, a per-tile indicator or the source timestamps can tell who is speaking. It runs for 120 seconds with a fixed speaking schedule for two people, and it has not been run. The steps, the sentence to read to the participants and the results table are in section 11 of [speaker-attribution-spike.md](speaker-attribution-spike.md#11-two-minute-speech-measurement-meet-probe-research-a1). The command is:

```bash
yarn workspace @calcom/notetaker-bot meet-probe "<meeting-url>" --out /root/meet-probe-speech.json --duration 120
```

### Limits

- The probe was not run by its authors. Every selector and page query in it is written from documentation and memory.
- The accessible tree is approximated: role, `aria-label`, one level of `aria-labelledby`, title and tooltip only.
- It looks at the top frame of the page only.
- The probe sends no stop signal, so it cannot show whether the browser was closed by the same signal that starts the bot's leave click (hypothesis L1). It shows whether the leave click works on its own.
- Timings are the probe's own and are not the bot's stop latency.
