# @calcom/notetaker-bot

The meeting bot service of the notetaker feature. A controller HTTP server receives signed join and
stop requests from the web app and starts one runner per meeting. A runner joins the meeting in a
browser with microphone and camera off, posts one notice, streams the meeting audio to a
speech-to-text provider, sends signed status events and transcript passages back to the app, and
leaves.

The wire contract is described in
[bot-control-api.md](../../specs/001-meeting-transcription/contracts/bot-control-api.md) (app to bot)
and [bot-events-webhook.md](../../specs/001-meeting-transcription/contracts/bot-events-webhook.md)
(bot to app). Its schemas and signing helpers live in `packages/lib/notetaker/botContract.ts`, the
only monorepo module this workspace imports.

## Status

No real meeting has been joined by this code: see [docs/verification-status.md](docs/verification-status.md)
for what has and has not been checked against a real service.

What exists: the controller HTTP server, the per-meeting runner, the Google Meet and Microsoft Teams
drivers, the Soniox speech-to-text provider, and the child-process and Docker runner launchers.

What was run here: unit tests against fakes, and a loopback test of the signed contract in both
directions (`src/contractLoop.test.ts`) with a scripted meeting.

What was not run here: any real meeting, browser, Docker image or container. Soniox was contacted on 2026-10-09 with a sample audio file only; see docs/verification-status.md. The
manual checks for those are [docs/smoke-test-google-meet.md](docs/smoke-test-google-meet.md),
[docs/smoke-test-microsoft-teams.md](docs/smoke-test-microsoft-teams.md) and
[docs/deployment.md](docs/deployment.md).

The runner withholds transcript passages until the in-meeting notice is posted. If the notice cannot
be posted within 30 seconds, the session ends as interrupted.

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `yarn workspace @calcom/notetaker-bot test` | Unit tests with this workspace's Vitest config (node environment) |
| `yarn workspace @calcom/notetaker-bot typecheck` | `tsc --noEmit` over `src`, `scripts` and the Vitest config |
| `yarn workspace @calcom/notetaker-bot dev` | Controller with reload, from `src/main.ts` |
| `yarn workspace @calcom/notetaker-bot build` | Bundle of the controller and the runner into `dist/` |
| `yarn workspace @calcom/notetaker-bot start` | Controller from the bundle |
| `yarn workspace @calcom/notetaker-bot fake-events --help` | CLI that posts signed events to the app without a meeting |
| `yarn workspace @calcom/notetaker-bot capture-google-state --help` | CLI that opens Chrome for a person to sign in to the bot's Google account and prints the value for `NOTETAKER_GOOGLE_STORAGE_STATE_B64` (not run by its authors) |

The root `yarn test` also collects this workspace's tests, under the root Vitest config.

## Configuration

Every variable is listed with its default in [.env.example](.env.example). Secrets come from
environment variables only and are never logged.

Google Meet can refuse an anonymous guest. The signed-in route is `NOTETAKER_GOOGLE_JOIN_MODE=account`
with a session captured by `scripts/capture-google-storage-state.ts`; account preparation, the capture
and inviting the bot's email are in [docs/smoke-test-google-meet.md](docs/smoke-test-google-meet.md),
section 8. None of it has been run against Google.

## Fake-meeting mode

`NOTETAKER_BOT_ADAPTER=fake` runs a scripted meeting instead of joining one. It is refused when
`NODE_ENV=production`. `NOTETAKER_FAKE_MEETING_SECONDS` sets the meeting length; it defaults to 5 and
has a minimum of 1.

No browser, Google account or Soniox key is needed, and the check of the meeting link on joins is
skipped. The script, with offsets from the moment the runner joins:

| Offset | Event |
|---|---|
| 0 ms | waiting |
| 300 ms | admitted |
| 400 ms | a second participant is present |
| 450 to 750 ms | one named speaker is speaking |
| 800 ms | two scripted utterances arrive |
| configured length | meeting ended |

The app receives `session.join_requested`, `session.admitted`, `session.notice_posted`,
`transcript.passages` (two passages, one with a named speaker and one with an unknown speaker) and
`session.ended` with `MEETING_ENDED`. A heartbeat appears only for meetings longer than 30 seconds.

To start it:

```
NOTETAKER_BOT_ADAPTER=fake NOTETAKER_BOT_SECRET=<secret> yarn workspace @calcom/notetaker-bot dev
```

On the app side set `NOTETAKER_BOT_PROVIDER=self_hosted`, `NOTETAKER_BOT_URL=http://127.0.0.1:4010`
and the same secret. This run against the web app was not performed in this change; the loopback test
`src/contractLoop.test.ts` covers the same path.

## Rules of this workspace

`src/workspaceRules.test.ts` fails when one of these is broken:

1. The only `@calcom/*` import is `@calcom/lib/notetaker/botContract`, and no relative import leaves this directory.
2. No non-test file under `src/` imports the file system or uses a browser recording, tracing, screenshot or PDF call: audio and video never reach a disk.
3. `playwright` is imported only by `src/platform/browser/PlaywrightChromeLauncher.ts` and by `scripts/`.
4. The process environment is read only in `src/config.ts`, `src/main.ts`, `src/runnerMain.ts` and `scripts/`.
5. Every file written without access to the real service it talks to carries the marker comment `UNVERIFIED AGAINST THE REAL SERVICE`.

## Further documents

Added by later changes: `docs/verification-status.md`, `docs/deployment.md`,
`docs/smoke-test-google-meet.md`, `docs/smoke-test-microsoft-teams.md`,
`docs/speaker-attribution-spike.md`.
