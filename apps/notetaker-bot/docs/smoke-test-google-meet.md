# Manual check against Google Meet, Chrome and Soniox

## 1. Status

Nothing in this document has been run by the people who wrote the code. Every command, expected result and selector below comes from documentation, memory and the source files, and none of it has been tried against Google Meet, Chrome or Soniox. Read "expected" as "expected (unconfirmed)". The register that records results is [verification-status.md](verification-status.md). It is empty until a person fills it in after this check (section 10).

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
- The driver sends the notice. It cannot confirm that the notice appeared. You confirm that by looking.
- A thrown read becomes `connection_lost` in the adapter, and one reconnect is tried.
- Meet needs a reply from a person. Be ready to admit the bot within the admission timeout (default 600 seconds).

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

Set `NOTETAKER_GOOGLE_JOIN_MODE=account` and use one of these routes.

Storage-state route:

1. On your own machine, sign in to the bot's Google account in a Playwright browser and save its storage state as a JSON file.
2. Encode it on one line: `base64 -w0 <state file>`.
3. Put the output in `NOTETAKER_GOOGLE_STORAGE_STATE_B64` and delete the JSON file. The bot decodes it in memory and does not write it.

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

## 9. Selectors to re-check

Keys are the 27 keys of `GOOGLE_MEET_SELECTORS` in `src/platform/GoogleMeetAdapter.ts`. The selector strings there are guesses written from memory. Open Meet's developer tools on the real page and check each one against what you see. Fill the last two columns. If the file does not exist yet when you read this, the keys below are the intended set and must be compared with the file.

Every alternative of every selector ends in `:visible`. This is because the page wrapper takes the first DOM match with `.first()`, and a hidden element earlier in the page would otherwise hide a visible one. Check that `:visible` after `:text(...)` works in a comma list in Playwright 1.57. This is not confirmed.

Order is by risk. A wrong key near the top ends sessions.

| Key | Purpose | Matched the page | Correction |
|---|---|---|---|
| `inMeetingMarker` | controls that exist only inside the call; first test of admission | | |
| `participantCountBadge` | number next to the people button | | |
| `participantTile` | one match per participant tile; fallback for the count | | |
| `chatButton` | opens the chat panel | | |
| `chatInput` | chat text field | | |
| `chatSendButton` | sends the notice | | |
| `waitingText` | text while waiting for admission | | |
| `deniedText` | request refused, unanswered, or guests not allowed | | |
| `removedText` | removed by a participant | | |
| `endedText` | meeting over; includes "You left the meeting" as a guess | | |
| `linkInvalidText` | unusable link | | |
| `activeSpeakerName` | name label of a tile that shows a speaking indicator | | |
| `turnOffMicrophone` | pre-join microphone toggle while on | | |
| `turnOffCamera` | pre-join camera toggle while on | | |
| `guestNameInput` | guest name field | | |
| `askToJoinButton` | request entry | | |
| `joinNowButton` | enter without a request | | |
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

- Speaker ids come from the displayed name, because the page wrapper cannot read Meet's participant id attribute. Two participants with the same display name are one participant to the attributor.
- No `source_identity` signal can be produced. Only the active-speaker indicator on screen can name a speaker, and its selector is a guess. Speaker attribution rules wait for task T175.
- Google may detect and block automated browsers. This was not tested.
- Google's terms for automating an account are an open question for the owner (research.md open question 3).
- An organisation can block guests. Such a meeting ends as `NOT_ADMITTED`.
- The notice is sent, not confirmed. Only a person looking at the chat can confirm it appeared.
- The participant count cannot be read if Meet puts it only in an `aria-label`. The wrapper has no attribute read.
- The page wrapper has no wait for hidden, no wait for one of several, and no sleep. The driver uses a composite selector instead.
- The runner decisions D1, D2 and D3 of the build plan await the owner. D1 as built leaves when the notice cannot be posted, which is stricter than the plan's text. Confirm which one the owner wants.
