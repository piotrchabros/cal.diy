# Deployment of the notetaker meeting bot

## 1. Status

The authors did NOT build the image, start a container or contact a Docker Engine. Nothing on this page is a result: the build command, the run command and the settings below are written from the code and from documentation and memory, and every shell snippet other than the build command is marked as not run. Section 8 is the manual check that a human runs; each result goes into [verification-status.md](verification-status.md) (see its `## Register` and `## Recording a check`).

This page covers task T192 and open question 2 of `specs/001-meeting-transcription/research.md`: production runs on a Docker host with one container per meeting, and the child-process launcher is for local development.

The files this page is the check for carry an "UNVERIFIED AGAINST THE REAL SERVICE" marker: [`../Dockerfile`](../Dockerfile), `src/runner/launcher/DockerEngineClient.ts` and `src/runner/launcher/DockerMeetingRunnerLauncher.ts`. Remove a marker only as `verification-status.md` describes.

## 2. What runs where

| Part | Entry file in the bundle | What it does |
|---|---|---|
| Controller | `dist/main.js` | One process. HTTP server on `NOTETAKER_BOT_HOST`:`NOTETAKER_BOT_PORT`. Receives signed join, state and stop requests from the web app and starts runners. |
| Runner | `dist/runnerMain.js` | One process per meeting. Joins the meeting, streams audio to Soniox, posts signed events to the join request's `callbackUrl`, leaves. |

The controller picks a launcher with `NOTETAKER_BOT_LAUNCHER`, in `src/runner/launcher/createMeetingRunnerLauncher.ts` (not read for this page; its behaviour beyond the two names is not stated here):

- `child_process` (default): the runner is a child process of the controller. For local development.
- `docker`: the runner is a container created through the Docker Engine HTTP API.

The contract between controller and runner, the same for both launchers:

- The join request reaches the runner in the environment variable `NOTETAKER_RUNNER_JOIN_REQUEST`, as base64 of the JSON.
- The runner reports its phase on stdout in lines of the form `@@notetaker-status {"phase":"IN_MEETING","lastEventSequence":7}`. The controller reads them (for Docker, from the container log).
- The runner takes SIGTERM as the request to stop and leave.

`src/main.ts` and `src/runnerMain.ts` are the two entry files; their source is not described here.

## 3. Building the image

From the repository root:

```sh
docker build --platform linux/amd64 -f apps/notetaker-bot/Dockerfile -t <image> .
```

Notes for whoever builds it:

- BuildKit is required. The ignore file for this build is `apps/notetaker-bot/Dockerfile.dockerignore`, which only BuildKit reads. The legacy builder ignores it and falls back to the root `.dockerignore`. That file excludes `node_modules`, `.next`, `dist`, `build`, `.git`, `.github`, coverage and test output, `.turbo`, logs, `.DS_Store`, `Thumbs.db` and `docs`. It does NOT exclude `.env*`, `specs` or `.ai`, so with the legacy builder the build context would include any `.env` file in the tree. It also excludes every `dist` directory and `docs`, which the bot build does not need. Use BuildKit.
- `linux/amd64` only. Playwright's `install chrome` script is reported not to support Linux arm64; this comes from a reading of the script during planning, not from a build, and this page's author did not read the script. On an arm64 host the `--platform` flag makes the build run under emulation, if the host has it set up; this was not tried.
- The image uses Node 20 (`node:20-bookworm`, `node:20-bookworm-slim`) because the task says so, while development and every test ran on Node 22 (build-plan correction C16). The bundle targets `node20`; nothing has run it on Node 20.
- Chrome stable is installed with `npx playwright install --with-deps chrome` and is not pinned. Two builds on different days can contain different Chrome versions. Record the version (section 8, step 2).
- The dependency install is `yarn install --immutable --mode=skip-build`. Skip-build keeps the root `postinstall` (Prisma client, app-store files) from running, because the bot bundle uses neither. Side effect to check: `esbuild`, which the build step uses, then runs without its own build script. That is the point of the skip-build line in step 1 of the manual check.
- The build needs network access to the npm registry, `dl.google.com` (Chrome) and the Debian mirrors, and copies the whole repository into the build stage (`COPY . .`), so it is slow and large on a big checkout.
- If the bundled classic Yarn of the `node:20-bookworm` image does not hand over to the repository's `yarnPath` (`.yarn/releases/yarn-4.12.0.cjs`, set in `.yarnrc.yml`), the `yarn install` line fails or installs differently. The fallback, not run, is to replace both `yarn` commands in the `Dockerfile` build stage by `node .yarn/releases/yarn-4.12.0.cjs install --immutable --mode=skip-build` and `node .yarn/releases/yarn-4.12.0.cjs workspace @calcom/notetaker-bot build`.

Shape of the image, as written in the `Dockerfile`: runtime stage on `node:20-bookworm-slim` with `NODE_ENV=production` and `DISPLAY=:99`; the bundle at `/app/dist`; `playwright@1.57.0` and `ws@8.18.3` installed in `/app` (the two modules the bundle leaves external); `xvfb` and Chrome; user `node` (uid 1000); no `VOLUME`, `EXPOSE` or `HEALTHCHECK`. The `ENTRYPOINT` starts Xvfb in the background and then runs `exec node "$@"`, so node is PID 1 and receives SIGTERM directly; `CMD` is `["dist/runnerMain.js"]`. The controller runs the same image with the command overridden to `dist/main.js`.

## 4. Running

Runner: nobody starts it by hand. The Docker launcher creates it and sends no `Cmd` and no `Entrypoint` in the create request (see `createContainer` in `DockerEngineClient.ts`), so a runner container runs the image defaults, `dist/runnerMain.js`.

Controller from the image (NOT RUN):

```sh
docker run -d --name notetaker-controller \
  -p 4010:4010 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  --env-file <file> \
  <image> dist/main.js
```

Requirements and cautions:

- `<file>` must set `NOTETAKER_BOT_HOST=0.0.0.0`; the default `127.0.0.1` is unreachable through `-p`. It also needs the variables of section 5, with obviously fake values in any example: `NOTETAKER_BOT_SECRET=<shared-secret>`, `NOTETAKER_BOT_LAUNCHER=docker`, `NOTETAKER_RUNNER_IMAGE=<image>`.
- The controller runs as user `node`, so `--group-add` gives it the group of the socket file.
- The socket mount is for the controller only. It gives the controller root-equivalent control of the host: anything that can talk to the controller's code, or that takes over the controller, can start any container. Do not mount it into a runner (the launcher does not).
- `--env-file` is read by Docker; values are passed as they are written, without quote handling.
- Alternative: run the controller on the host, no socket mount: `yarn workspace @calcom/notetaker-bot start` after `yarn workspace @calcom/notetaker-bot build`, with the same variables in the environment. The host user then needs access to the Docker socket.
- `GET /healthz` is the only unsigned route. It answers `{"ok":true,"activeSessions":<n>,"capacity":<n>}` with 200, or `{"ok":false}` with 503 when the launcher cannot count. Every other route needs the two signature headers (section 8, step 4).

## 5. Environment

Columns: "controller" = read by `getControllerConfig` in `src/config.ts`; "runner" = read by `getRunnerConfig`; "forwarded" = copied into every runner container by the Docker launcher, which takes `pickRunnerEnv(process.env)` over `RUNNER_ENV_KEYS`. `pickRunnerEnv` copies a variable only when the controller's environment has it with a non-empty string; an empty `VAR=` is not forwarded (a value of only spaces is, and the runner then trims it to unset). Defaults are those of `config.ts`.

| Variable | Default | Controller | Runner | Forwarded | Note |
|---|---|---|---|---|---|
| `NOTETAKER_BOT_SECRET` | none, required | yes | yes | yes | Must equal the web app's secret. |
| `NOTETAKER_BOT_HOST` | `127.0.0.1` | yes | no | no | Set `0.0.0.0` in a container. |
| `NOTETAKER_BOT_PORT` | `4010` | yes | no | no | 0 to 65535. |
| `NOTETAKER_BOT_CAPACITY` | `10` | yes | no | no | Integer of at least 1. |
| `NOTETAKER_BOT_LAUNCHER` | `child_process` | yes | no | no | `child_process` or `docker`. |
| `NOTETAKER_RUNNER_IMAGE` | none | yes | no | no | Required when the launcher is `docker`. |
| `NOTETAKER_DOCKER_SOCKET` | `/var/run/docker.sock` | yes | no | no | Used only by the `docker` launcher. |
| `NOTETAKER_DOCKER_NETWORK` | empty (engine default) | yes | no | no | See section 6. |
| `NOTETAKER_BOT_ADAPTER` | `real` | yes | yes | yes | `real` or `fake`. |
| `NOTETAKER_FAKE_MEETING_SECONDS` | `5` | no | yes | yes | Integer of at least 1; fake adapter only. |
| `SONIOX_API_KEY` | none | no | yes | yes | Required in the runner when the adapter is `real`. |
| `SONIOX_WS_URL` | built-in default | no | yes | yes | Must be `ws:` or `wss:`. |
| `SONIOX_MODEL` | built-in default | no | yes | yes | |
| `NOTETAKER_GOOGLE_JOIN_MODE` | `guest` | no | yes | yes | `guest` or `account`. |
| `NOTETAKER_GOOGLE_STORAGE_STATE_B64` | none | no | yes | yes | Base64 of a JSON object; decoded in memory. |
| `NOTETAKER_GOOGLE_ACCOUNT_EMAIL` | none | no | yes | yes | Account mode without storage state. |
| `NOTETAKER_GOOGLE_ACCOUNT_PASSWORD` | none | no | yes | yes | Account mode without storage state. |
| `NOTETAKER_CHROME_CHANNEL` | `chrome` | no | yes | yes | |
| `NOTETAKER_CHROME_HEADLESS` | `false` | no | yes | yes | `true` or `false` only. |
| `NOTETAKER_LOG_LEVEL` | `info` | yes | yes | yes | `debug`, `info`, `warn`, `error`, `silent`. |
| `NODE_ENV` | none (the image sets `production`) | yes | yes | yes | Not in `.env.example`. |
| `TZ` | none | no | no | yes | Not in `.env.example`; forwarded only, not read by `config.ts`. |

Consequences:

- The runner variables are set on the controller, because the controller is what forwards them. A container's own `DISPLAY` is the image's `:99`; it is not forwarded.
- The controller does NOT validate the runner variables. `getControllerConfig` does not look at `SONIOX_API_KEY`, `SONIOX_WS_URL` or the Google variables. A controller with no `SONIOX_API_KEY` starts and answers `/healthz`; the failure shows per meeting, when the runner container starts, validates its own environment and exits. Whether `src/startController.ts` (owned by another unit, not read here) adds a boot-time check is not stated here; do not assume it.
- Variable names, never values, appear in configuration errors.
- `NOTETAKER_BOT_ADAPTER=fake` together with `NODE_ENV=production` is refused, by the controller and by the runner. The image default is `NODE_ENV=production`, so a fake run needs `NODE_ENV=development` (or any value other than `production`) in the controller's environment; the controller then forwards it to the runner containers.
- Keep `NOTETAKER_CHROME_HEADLESS=false` in the image. Xvfb is there for exactly that; headless mode is a different browser mode that was not looked at.
- `NOTETAKER_FAKE_MEETING_SECONDS` is read by the runner only, but it reaches the runner only if it is in the controller's environment.

Web app side, named only (set in the app's environment, not here): `NOTETAKER_BOT_PROVIDER=self_hosted`, `NOTETAKER_BOT_URL` (the controller's address, as the app reaches it) and `NOTETAKER_BOT_SECRET` with the same value as the bot's.

## 6. Docker settings and capacity

All values are taken from `DockerEngineClient.ts` and `DockerMeetingRunnerLauncher.ts`.

| Setting | Value |
|---|---|
| Socket | `NOTETAKER_DOCKER_SOCKET`, default `/var/run/docker.sock`. |
| Engine API version | Hard-coded `v1.43` in every request path. From memory, that is the API of Docker Engine 24.0; the client has no setting for it. An Engine that does not accept it answers errors that the launcher reports as a failed step. |
| Request timeout | 10 s per call; `stop` adds the grace period to it. |
| Container name | `notetaker-` + the session id with every character outside `[A-Za-z0-9_.-]` replaced by `_`. |
| Label | `com.cal.notetaker.session=<sessionId>` |
| `Tty` | `true`; stdout and stderr are therefore merged into one log stream. |
| `AutoRemove` | `true` |
| Shared memory (`ShmSize`) | 1073741824 bytes (1 GiB). The source comment says Chromium crashes on large pages with the 64 MiB default. That is from memory, not measured. |
| CPU and memory limits | None set. Per-runner memory use was not measured, so there is no figure to size a host with. |
| Network | `NOTETAKER_DOCKER_NETWORK` is sent as `NetworkMode` when set. Empty means the engine default. A runner needs outbound access to the meeting platform (Google Meet or Microsoft Teams), to Soniox, and to the join request's `callbackUrl`. If the app is on the Docker host itself, `localhost` inside the container is not the host; use an address the container can reach. |
| Environment | The forwarded variables plus `NOTETAKER_RUNNER_JOIN_REQUEST`. |
| Command / entrypoint | Not sent: image defaults. |

Capacity:

- `NOTETAKER_BOT_CAPACITY` counts RUNNING containers carrying the label above, as listed by the Engine. It is therefore not lost when the controller restarts, and several controllers that use one Engine share the count.
- The controller adds the launches it has in flight. A join beyond capacity answers 503 with `{"error":"at_capacity"}`. Any other launch failure answers 503 with `{"error":"launch_failed"}`.
- A repeated join for a session that has a container returns that container's id and starts nothing (while the controller still holds the session in memory; see section 9).

Stop:

- Stop sends the container a stop request with a grace period of 15 seconds. The Engine's stop sends SIGTERM first; after 15 s it sends SIGKILL.
- The launcher then removes the container if it is still there. A failed removal is only logged.
- On controller shutdown (SIGTERM), every running labelled container is stopped and removed the same way.

## 7. Nothing is stored (FR-030)

- The create request has no `Binds`, `Mounts` or `Volumes`, and the image has no `VOLUME`. The build plan says the launcher's unit test asserts the first part against a fake.
- `AutoRemove` and the removal call discard the container's writable layer, including Chrome's temporary profile, when the container goes away.
- Rule 2 of `src/workspaceRules.test.ts` forbids file-system imports and browser recording, tracing, screenshot and PDF calls in `src/`.
- Checking all of this on a real Engine is part of section 8, step 5.

Secrets:

- The forwarded environment (the bot secret, the Soniox key, the Google credentials) and the join request travel in the create request and are visible in `docker inspect` and in the container's environment to anyone who can use the Docker socket. Treat socket access as access to these secrets.
- Engine error messages are not copied into the controller's logs, because the create request carries these values.

Sandbox: Playwright adds `--no-sandbox` to Chrome unless `chromiumSandbox` is set, and `PlaywrightChromeLauncher.ts` does not set it (it passes `channel`, `headless` and two flags: `--autoplay-policy=no-user-gesture-required`, `--mute-audio`). Chrome therefore runs without its own sandbox, as user `node`, and the container is the isolation boundary. Do not run runner containers with the Docker socket, `--privileged` or host networking.

## 8. Manual check

Run these steps in order, on a Docker host you may use for it, and record each result as [verification-status.md](verification-status.md#recording-a-check) describes. A step that fails is a result too; record what happened. Placeholders in angle brackets are yours to fill. The shell snippets here were NOT run.

1. Build the image with the command of section 3. Record the Docker version (`docker version`), the image digest, the image size, the build duration, and whether plain `yarn` in the build stage reached the repository's Yarn 4 and whether the skip-build install (esbuild without its build script) and the `yarn workspace @calcom/notetaker-bot build` step succeeded. If you used the fallback of section 3, say so.
2. Run `docker run --rm --entrypoint node <image> --version`. Then check the user id (for example `docker run --rm --entrypoint id <image> -u`; expected 1000) and the Chrome version (`docker run --rm --entrypoint google-chrome <image> --version`). Record all three outputs. These commands are not run.
3. Start the controller as in section 4 with, in the env file: `NOTETAKER_BOT_SECRET=<shared-secret>`, `NOTETAKER_BOT_HOST=0.0.0.0`, `NOTETAKER_BOT_LAUNCHER=docker`, `NOTETAKER_RUNNER_IMAGE=<image>`, `NOTETAKER_BOT_ADAPTER=fake`, `NODE_ENV=development`, `NOTETAKER_FAKE_MEETING_SECONDS=20`. Call `GET /healthz`. Expected: 200 with `ok` true, `activeSessions` 0 and your capacity. Record the body, or the container log if the controller did not start.
4. Send one signed join request.
   - Preferred: through the web app. Set `NOTETAKER_BOT_PROVIDER=self_hosted`, `NOTETAKER_BOT_URL=<controller address>` and the same secret, enable the notetaker on a Google Meet booking, and run the app's dispatch sweep. (With the fake adapter the controller is expected to skip the meeting URL check, per the build plan; if the app cannot be made to send a usable link, use the manual route.)
   - By hand: send `POST /v1/sessions` with two headers. `X-Notetaker-Timestamp` is the current time in Unix seconds, digits only. `X-Notetaker-Signature` is `sha256=` followed by the lowercase hex HMAC-SHA256, keyed with the shared secret, of the string `<timestamp>.<raw request body>`, using the body bytes exactly as sent. The controller accepts a timestamp within 300 seconds of its clock in either direction. For `GET` requests the body is empty, so the signed string is `<timestamp>.`. The body must match `notetakerBotJoinRequestSchema` in `packages/lib/notetaker/botContract.ts`: `sessionId`, `platform` (`GOOGLE_MEET` or `MICROSOFT_TEAMS`), `meetingUrl` (a URL), `displayName`, `noticeMessage`, `scheduledStartAt` (UTC date-time string), `callbackUrl` (a URL your receiver serves), and `limits` with the four positive integers `admissionTimeoutSeconds`, `noShowTimeoutSeconds`, `aloneTimeoutSeconds`, `maxDurationSeconds`. The callbacks the runner sends back are signed the same way; verify them with the same helper.
   - Expected: 202 with `sessionId` and `externalRef` (the container id).
5. While the fake meeting runs, record:
   - `docker ps --filter label=com.cal.notetaker.session` lists one container named `notetaker-<sessionId>`.
   - `docker inspect <container>` shows `HostConfig.ShmSize` 1073741824, `HostConfig.AutoRemove` true, `Config.Tty` true, `Config.Cmd` and `Config.Entrypoint` equal to the image's, and empty `Mounts`, `HostConfig.Binds` and `Config.Volumes`. Note that the secrets are visible there, as section 7 says.
   - `docker logs <container>` contains `@@notetaker-status ` lines.
   - A signed `GET /v1/sessions/<sessionId>` answers 200 with the phase and `lastEventSequence` (expected phases move through `STARTING`, `WAITING` or `IN_MEETING`, then `ENDED`).
   - `docker exec <container> ps -o pid,user,args` or the equivalent shows whether `node` is PID 1 and which user runs it. Record what it shows.
6. After the fake meeting has ended: the container is gone (`docker ps -a --filter label=com.cal.notetaker.session`), and the callback receiver got `session.ended` with reason `MEETING_ENDED`. Record how long after the scripted end the container disappeared.
7. Repeat the same join request (same `sessionId`): expected 202 and still one container. Then restart the controller with `NOTETAKER_BOT_CAPACITY=1`, use a longer `NOTETAKER_FAKE_MEETING_SECONDS`, send a join, and while it runs send a join with a different `sessionId`: expected 503 `at_capacity`. Also record what a repeated join of the first, running session answers after that restart (section 9 expects 503; record what happens).
8. With a long fake meeting (at least 120 seconds) running, send a signed stop: `POST /v1/sessions/<sessionId>/stop` with the body `{"reason":"STOPPED_BY_HOST"}`. Expected: 202; the callback gets `session.ended` with reason `STOP_REQUESTED`; the container is gone well inside the 15 s grace period. Record the elapsed time, and the controller's response time against the app's 10 s client timeout. This is the check of the entrypoint's signal path: a container that is only removed after the full grace period means node did not receive SIGTERM.
9. Restart the controller while a meeting runs. Expected: `/healthz` still counts it in `activeSessions`, and a signed stop still works. Record what happens to `GET /v1/sessions/<sessionId>` after the restart and after the container is gone (section 9 expects 404 after both).
10. Real mode in the image, Chrome under Xvfb: run [smoke-test-google-meet.md](smoke-test-google-meet.md) with `NOTETAKER_BOT_LAUNCHER=docker` and `NOTETAKER_BOT_ADAPTER=real` (and `NODE_ENV=production`, the image default). For Microsoft Teams see [smoke-test-microsoft-teams.md](smoke-test-microsoft-teams.md). Record whether the browser launched headed under `DISPLAY=:99`, and any "Chrome failed to start" log, which is also how a failed Xvfb shows (section 9).

For the speaker-attribution questions, which this check does not answer, see [speaker-attribution-spike.md](speaker-attribution-spike.md).

## 9. Known limits, none measured

Each point below comes from reading the code; none was observed.

- `getStatus` reads the last 50 lines of the container log. With `Tty` on, the runner's stderr logging is in the same stream. After more than 50 lines follow the last status line, a running container reports `STARTING` with sequence 0.
- Stop can hold the controller's answer for up to the 15 s grace period, while the app's client times out after 10 s. What the app does with a stop that timed out was not checked.
- `AutoRemove` deletes the container at its end. Once it is gone `getStatus` returns nothing, and the controller reports `ENDED` only for sessions still in its in-memory registry. After a controller restart such a session answers 404.
- A repeated join after a controller restart is checked against capacity by the controller before the launcher's lookup by name, so at capacity it can answer 503 for a session that has a running container. The launcher's own idempotence is only reached when there is room.
- Two session ids that differ only in characters outside `[A-Za-z0-9_.-]` map to one container name. The second would be taken for the first. The launcher cannot tell them apart.
- Chrome runs without its sandbox (section 7).
- The entrypoint waits for the X socket `/tmp/.X11-unix/X99` for up to 50 polls of 0.1 s, about 5 s, and starts node anyway. A failed X server therefore shows as a browser launch failure in the runner, not as a failed container start.
- Nothing prunes an ended session from the controller's registry unless somebody queries it after the end; the registry is in memory only.
- `NOTETAKER_BOT_CAPACITY` limits runners, not the memory they use; no per-runner figure exists.
