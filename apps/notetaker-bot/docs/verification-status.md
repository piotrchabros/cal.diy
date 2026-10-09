# Verification status of the notetaker meeting bot

## Status

No real meeting was joined by this code. No container image was built. Soniox and the Docker daemon were not contacted, and no browser was opened. Every file listed in the register below was written from documentation and memory. It is exercised only by tests that use fakes, stubs and the type-checker, and the register says, row by row, which of those applies. "Verified here against" in the register describes only that: a fake, a local stub server, or the type-checker. It is never a statement about the real service.

Each registered file starts with an "UNVERIFIED AGAINST THE REAL SERVICE" marker comment (the `Dockerfile` carries it as `#` comments) that points to this page. The fourth column of the register is empty on purpose: it stays empty until a person has run the manual check for that file against the real service and recorded the result (see "Recording a check").

## Register

| File | Verified here against | Not verified | Verified against the real service by / on |
|---|---|---|---|
| `src/audio/captureScript.ts` | init script evaluated in `node:vm` with hand-written stubs of `RTCPeerConnection`, `AudioContext`, `MediaStream`, `btoa`, `setInterval` and both bindings; the decoders are tested directly | remote WebRTC audio reaching WebAudio in real Chrome; the 16 kHz context being honoured; `ScriptProcessorNode` in a background tab; the scale of the contributing-source timestamp against `Date.now()`; Meet's Content Security Policy and Trusted Types; the `__name` shim under `tsx` and under the esbuild bundle (the test uses a hand-built `__name(...)` call); `--mute-audio` together with the processor connected to the destination | Partial, Piotr Chabros, 2026-10-09, Chrome 155.0.8059.39 (channel `chrome`), macOS: `scripts/capture-smoke.ts` loopback passed (39 frames in 5 s, all non-silent, 0 rejected payloads, 19 activity calls). Remains: everything inside a real Meet call (not reached, see "Google Meet guest check, 2026-10-09") |
| `src/stt/sonioxProtocol.ts` | only through the provider test: a local `ws` server on 127.0.0.1 that speaks the format this file itself assumes | the WebSocket URL, model name, start-message fields, token fields (`is_final`, `speaker`, `language`), the endpoint token, whether an empty text frame ends the stream and is answered with `finished`, the error shape; no request was sent to Soniox | Not reached on 2026-10-09: the Meet guest join was refused before any audio, so nothing was sent to Soniox |
| `src/stt/SonioxRealtimeProvider.ts` | the same local stub socket: start message, binary frames, grouping, time offset after one reconnect, flush on close, API key absent from logs | real Soniox; abrupt socket loss (tests simulate loss with a graceful server-side close); a stream length cap below the meeting length consuming the single reconnect; error responses are not classified (a bad key costs one pointless reconnect); fragmentation of utterances if `language` is missing on some tokens; whether Soniox accepts the roughly 1.9 MB silence frame a 60 s rejoin produces; language and diarization quality | Not reached on 2026-10-09 (as for `sonioxProtocol.ts`) |
| `src/speakers/SpeakerAttributor.ts` | unit tests with hand-made samples against its own written rules | `PROVISIONAL_ATTRIBUTION_RULES` are guesses; task T175 was not run; SC-005 is not promised; no adapter emits `source_identity`, so the contributing-source signal can name nobody until a driver method exists (report 2B) | |
| `src/platform/browser/PlaywrightChromeLauncher.ts` | the type-checker only, against the Playwright 1.57 types; no test; not executed | everything at run time: launching channel `chrome`, headed under Xvfb, context options, storage state, the fixed timeouts (navigation 45 s, click and fill 10 s), close and crash wiring | Partial, Piotr Chabros, 2026-10-09, Chrome 155.0.8059.39, macOS, headed: channel `chrome` launches, the context opens and Meet loads, the runner closes the browser and exits 0. Remains: clicks and typing on a real page, storage state, crash wiring, Xvfb |
| `src/platform/browser/BrowserPlatformAdapter.ts` | `FakeMeetingPage` and a scripted driver | any real page: polling, init-script timing, the 3 s driver leave cap, reconnecting | Partial, Piotr Chabros, 2026-10-09: `session.join_requested` then `session.ended` (`NOT_ADMITTED`) reached a local signed receiver in order, signatures valid. Remains: waiting, admitted, heartbeat, removed, ended, reconnect |
| `src/platform/GoogleMeetAdapter.ts` | `FakeMeetingPage`: control flow only (join click order, microphone and camera off first, state mapping, speaker diffing, notice, leave, reconnect, no forbidden click) | every selector; the guest join flow; account sign-in and the display name; bot detection; Google's terms for automating an account | Partial, Piotr Chabros, 2026-10-09, guest mode, Meet in English (US): `deniedText` matched Meet's real "You can't join this video call" page. Meet refused the automated guest outright (see "Google Meet guest check, 2026-10-09"); no other selector or step was reached |
| `src/platform/MicrosoftTeamsAdapter.ts` | `FakeMeetingPage`: control flow only | every selector; the guest join flow | |
| `src/runner/launcher/DockerEngineClient.ts` | a local stub HTTP server over host and port: method, path, query and JSON body of each call, the 304, 404 and 409 mappings, the timeout | the unix-socket transport; Engine API paths and fields at the hard-coded version `v1.43`; the raw `Tty` log format; `AutoRemove` timing; no daemon was contacted | |
| `src/runner/launcher/DockerMeetingRunnerLauncher.ts` | a hand-written `IDockerEngine` fake | real containers; status under-reporting past the 50-line log tail; stop latency against the app's 10 s timeout; the removal race; whether the 1 GiB of shared memory is needed (the source comment is from memory) | |
| `Dockerfile` | nothing: not built, no instruction executed | the whole build (including the skip-build install and esbuild without its build script), the Chrome install on `node:20-bookworm-slim`, the Xvfb entrypoint and SIGTERM delivery to node, the non-root user (Chrome runs without its own sandbox, see `deployment.md` section 7), the bundle on Node 20, image size | |
| `scripts/spike-speaker-attribution.ts` | the type-checker only; not executed | everything, selectors included | |
| `scripts/capture-smoke.ts` | the type-checker only; not run | everything; it is itself the manual check of `captureScript.ts` | Piotr Chabros, 2026-10-09, Chrome 155.0.8059.39 (channel `chrome`), macOS: ran and exited 0 (`frames=39 audioMs=4992 nonSilentFrames=39 rejectedPayloads=0 activityCalls=19 activitySources=19`). Marker kept until `captureScript.ts` is checked in a real call |

## Google Meet guest check, 2026-10-09

Run by Piotr Chabros from [`smoke-test-google-meet.md`](smoke-test-google-meet.md), on macOS with Google Chrome 155.0.8059.39 (channel `chrome`, headed) and guest join mode. A throwaway meeting was used and no meeting content was kept.

- Step 0 (`scripts/capture-smoke.ts`) passed: exit 0, 39 frames in 5 s, 0 rejected payloads.
- Step 1 passed: the controller started with `NOTETAKER_BOT_ADAPTER=real` and `NOTETAKER_BOT_LAUNCHER=child_process`, and `/healthz` answered 200 `{"ok":true,"activeSessions":0,"capacity":10}`. A real runner child process was started through `tsx` and exited 0.
- Step 2 (guest join, route B: a hand-signed `POST /v1/sessions` with a local signed events receiver) was blocked. The bot's browser loads Meet's "You can't join this video call" page straight away: no name field, no "Ask to join" button, and nothing reaches the host. The same link in a normal Chrome Incognito window shows the name field and "Ask to join", so the meeting allows guests. Meet is refusing the automated browser (`navigator.webdriver` is `true` in it). The bot ended the session `NOT_ADMITTED` about 3 s after the browser opened, which is the correct reading of that page.
- Consequence: checklist items 2 to 20 of the Google Meet check, and every Soniox check, cannot be reached in guest mode as built. Getting past the refusal means either masking the browser automation or joining with an account (step 3). Both touch Google's terms (research.md open question 3) and are the owner's decision. Step 3 was not run.

## Manual checks

| File(s) | Service | Where the check is |
|---|---|---|
| `src/audio/captureScript.ts` | Chrome WebRTC and WebAudio | [`../scripts/capture-smoke.ts`](../scripts/capture-smoke.ts), then [`smoke-test-google-meet.md`](smoke-test-google-meet.md) |
| `src/stt/sonioxProtocol.ts`, `src/stt/SonioxRealtimeProvider.ts` | Soniox realtime API | [`smoke-test-google-meet.md`](smoke-test-google-meet.md) |
| `src/platform/browser/PlaywrightChromeLauncher.ts`, `src/platform/browser/BrowserPlatformAdapter.ts`, `src/platform/GoogleMeetAdapter.ts` | Google Meet in Chrome | [`smoke-test-google-meet.md`](smoke-test-google-meet.md) |
| `src/platform/MicrosoftTeamsAdapter.ts` | Microsoft Teams web | [`smoke-test-microsoft-teams.md`](smoke-test-microsoft-teams.md) |
| `src/speakers/SpeakerAttributor.ts` | attribution rules of T175 | [`speaker-attribution-spike.md`](speaker-attribution-spike.md) |
| `src/runner/launcher/DockerEngineClient.ts`, `src/runner/launcher/DockerMeetingRunnerLauncher.ts`, `Dockerfile` | Docker Engine API and the image build | [`deployment.md`](deployment.md#8-manual-check) |
| `scripts/spike-speaker-attribution.ts`, `scripts/capture-smoke.ts` | Google Meet in Chrome; Chrome WebRTC and WebAudio | the header comment of each script |

## Recording a check

1. Run the manual check for the file (table above).
2. Fill the fourth column of its row with who ran it, the date, and the versions used: browser, Docker Engine, provider model, as far as they apply.
3. Remove the marker comment from the top of the file.
4. In the same change, delete the file's path from the `MARKED_FILES` list in `src/workspaceRules.test.ts`. Rule 5 of that test reads every file in `MARKED_FILES` that exists and reports a violation when the text "UNVERIFIED AGAINST THE REAL SERVICE" is absent. A file whose marker was removed but which is still listed therefore fails the test. A listed path that does not exist is skipped silently.
5. A partial result (some of "Not verified" confirmed, some not) keeps the marker, stays in `MARKED_FILES`, and is noted in the row: what was confirmed, by whom, when, and what remains.

## Also not verified (files without a marker)

- All tests ran on Node 22; the image is built on Node 20. `redirect: "manual"` and `response.body?.cancel()` in `EventSender` were exercised on Node 22 only.
- No `EventSender` or `fake-events.ts` request reached the app's real events route; quickstart scenarios 4 and 11 were not run. The env-file path and posting loop of `fake-events.ts` were only type-checked.
- `tsx` running the CommonJS workspace that imports TypeScript source from `@calcom/lib`, and `process.execArgv` carrying the loader into a real runner process: the child-process launcher was run once against a plain `node -e` child only.
- The esbuild bundle of `main.ts` and `runnerMain.ts` (externals, `__dirname` of the bundle).
- `yarn install --mode=skip-build`, the exact lockfile diff, and the `esbuild`/`tsx` resolution without build scripts: planning estimates, measured only in a scratch project.
- Decisions D1 (notice that cannot be posted), D2 (three consecutive 401 answers) and D3 (Google guest join mode by default) are the planner's and await the owner.
- The no-show deadline is now the later of the scheduled start and the runner's start (report fix1); that reading contradicts three documents and awaits the owner.
- A session nobody queries after its meeting is never pruned from the controller registry; the app's reaction to a stop that times out was not checked; the environment passed to a container, including the bot secret and the Soniox key, is visible in `docker inspect`.
- Whether CI has a job that enumerates workspaces or runs an unfiltered `turbo run build`.
