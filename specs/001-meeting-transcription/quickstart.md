# Quickstart: Meeting Transcription Notetaker

Links: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

## What this validates

This guide proves the notetaker feature works end to end without a real meeting. A fake bot replays scripted events through the same service and HTTP paths a real bot uses, so the booking lifecycle, status machine, transcript and summary, notifications, sharing and the event contract can all be checked on a laptop. It was written before the feature exists: commands marked "(added by this feature)" do not exist in the repo today.

## Prerequisites

- PostgreSQL from `docker-compose.yml` running locally, and dependencies installed with `yarn`.
- An `.env` copied from `.env.example` (`cp .env.example .env`), with the notetaker variables from the next section added.
- Migrations applied with `yarn workspace @calcom/prisma db-migrate`. The feature adds the notetaker tables, enums and a migration that seeds the `notetaker` feature flag with `enabled = false`.
- Generated types refreshed with `yarn prisma generate`.
- Feature flag `notetaker` enabled: set `Feature.enabled = true` for slug `notetaker` (for example in `yarn db-studio`).
- A sign-in user from the seeded test users, for example `pro` with password `pro`.
- Trigger.dev is optional. Without it, the sync tasker runs inline (`ENABLE_ASYNC_TASKER="false"`), and the dispatch sweep is driven by calling the cron route `GET /api/cron/notetaker` (added by this feature), authenticated with `CRON_API_KEY`, sent either as the `authorization` header or as the `apiKey` query parameter (`Bearer ${CRON_SECRET}` is also accepted). A call with valid credentials returns `{ "ok": true }`; any other call gets 401. For example: `curl -H "authorization: $CRON_API_KEY" http://localhost:3000/api/cron/notetaker`. Every "call the sweep" step below means this request.
- Start the web app with `yarn dev` after the environment is set.

## Environment

| Variable | Value for a fake-bot run | Notes |
|---|---|---|
| `NOTETAKER_BOT_PROVIDER` | `fake` | Default in dev and test. Selects `FakeBotGateway`. |
| `NOTETAKER_BOT_SECRET` | any non-empty string | Signs and verifies bot events (HMAC). Needed even with the fake bot, and used by `fake-events.ts`. |
| `NOTETAKER_FAKE_SCENARIO` | `happy` | See the next section for every value. |
| `ANTHROPIC_API_KEY` | unset | Unset uses the stub summary generator. Set it to exercise the real generator. |
| `NOTETAKER_ENABLED_PLATFORMS` | `GOOGLE_MEET` (default) | Google Meet only at launch. |
| `NOTETAKER_JOIN_LEAD_SECONDS` | `120` (default) | How early the sweep dispatches before the start time. |
| `NOTETAKER_ADMISSION_TIMEOUT_SECONDS` | `600` (default) | Wait to be admitted (FR-010). |
| `NOTETAKER_NO_SHOW_TIMEOUT_SECONDS` | `900` (default) | Wait for anyone else to join (FR-010). |
| `NOTETAKER_ALONE_TIMEOUT_SECONDS` | `120` (default) | Leave when alone (FR-010). |
| `NOTETAKER_MAX_DURATION_SECONDS` | `14400` (default) | Four-hour cap (FR-010). |
| `NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS` | `180` (default) | Watchdog for a silent bot. |
| `NOTETAKER_SUMMARY_MIN_WORDS` | `40` (default) | Below this the summary is `NOT_ENOUGH_CONTENT`. |

`NOTETAKER_BOT_URL`, `NOTETAKER_SUMMARY_MODEL` and the bot-side `SONIOX_API_KEY` are not needed for a fake-bot run. The default limits are fine; lower them only if you want a faster timeout check.

## Fake bot scenarios

`NOTETAKER_FAKE_SCENARIO` selects the event script `FakeBotGateway` emits. End states follow the session state machine in [data-model.md](./data-model.md).

| Scenario | Status | Reason | Transcript completeness |
|---|---|---|---|
| `happy` | ready (`READY`) | none | complete (`COMPLETE`) |
| `not_admitted` | failed (`FAILED`) | not admitted (`NOT_ADMITTED`) | none |
| `meeting_did_not_start` | failed (`FAILED`) | meeting did not start (`MEETING_DID_NOT_START`) | none |
| `no_speech` | failed (`FAILED`) | no speech detected (`NO_SPEECH_DETECTED`) | none (zero passages) |
| `removed_by_participant` | ended early (`ENDED_EARLY`) when removed after admission with content; failed (`FAILED`) if removed before admission or with no passages | removed by participant (`REMOVED_BY_PARTICIPANT`) | partial (`PARTIAL`) after admission with content, none otherwise |
| `interrupted` | ended early (`ENDED_EARLY`) with content; failed (`FAILED`) with no passages | interrupted (`INTERRUPTED`) | partial (`PARTIAL`), with the interruption point shown; none when failed |
| `length_limit` | ready (`READY`) with content | length limit reached (`LENGTH_LIMIT_REACHED`) | truncated (`TRUNCATED`) |
| `link_unusable` | failed (`FAILED`) | meeting link unusable (`MEETING_LINK_UNUSABLE`) | none |
| `manual` | depends on the events you post | depends on the events you post | depends on the events you post |

A session that ends `FAILED` never keeps a transcript. With `manual`, nothing is scripted. You post signed events yourself with `apps/notetaker-bot/scripts/fake-events.ts` (added by this feature), which calls the real events route and so exercises the HTTP contract in [bot-events-webhook.md](./contracts/bot-events-webhook.md). The end state depends on the events you send.

## Setup

1. Complete the prerequisites and set `NOTETAKER_FAKE_SCENARIO=happy`.
2. Sign in as `pro` / `pro`.
3. Create an event type whose location is Google Meet. For a fake-only run without a Google connection, use a custom link location such as `https://meet.google.com/abc-defg-hij`; it is classified as `GOOGLE_MEET`.
4. Open the public booking page for that event type and book it as a guest, for a start time two minutes ahead. Note the booking `uid`.
5. Open `/booking/{uid}/notetaker` as the host to see the notetaker panel for that booking.

Restart the dev server (or the test process) when you change `NOTETAKER_FAKE_SCENARIO`. Each scenario below needs its own booking.

## Validation scenarios

### 1. Core flow: enable, join, transcript

Proves: User Story 1 (all scenarios), FR-001, FR-003, FR-007, FR-009, FR-017, FR-020, FR-023.

Steps:
1. With scenario `happy`, enable the notetaker on the booking from the booking page.
2. Call the sweep: `GET /api/cron/notetaker` with `CRON_API_KEY` as the `authorization` header or the `apiKey` query parameter (`Bearer ${CRON_SECRET}` also works). It is added by this feature and returns `{ "ok": true }`.
3. Watch the status on the booking.
4. Open `/booking/{uid}/notetaker`.
5. Check the mail log.

Expected:
- After enabling, the status is scheduled.
- After the sweep, the status moves through waiting to be admitted, transcribing and processing to ready.
- The page shows speaker-attributed, timestamped passages in spoken order.
- A results-ready email is in the mail log with a link to the booking and no transcript text.

### 2. Turning it off, and never turning it on

Proves: User Story 1 scenarios 4 and 5, FR-003.

Steps:
1. Enable the notetaker on a new booking, then disable it before calling the sweep.
2. Call the sweep.
3. On a second booking where the notetaker was never enabled, call the sweep too.

Expected: no session row and no transcript for either booking, and no notice is posted.

### 3. Transparency and removal by a participant

Proves: User Story 2 scenarios 1 to 5, FR-012, FR-013, FR-014, FR-015, FR-016, FR-034.

Steps:
1. Enable the notetaker on an existing booking and check the guest's mail log.
2. Inspect the join request captured by `FakeBotGateway` (see [bot-control-api.md](./contracts/bot-control-api.md)).
3. Switch to scenario `removed_by_participant`, book again, enable, and call the sweep.
4. Try to enable the notetaker again on that booking.
5. On a separate booking that already sent the notice, turn the notetaker off and on again, and check the mail log.

Expected:
- Every attendee receives the attendee notice email, with the host named (see [notifications.md](./contracts/notifications.md)).
- Turning the notetaker off and on again does not re-send the notice to attendees already told.
- The captured join request has a `displayName` that names the host and a localized `noticeMessage`.
- The status is ended early (`ENDED_EARLY`) with the reason removed by participant, and re-enabling is refused.

### 4. Host stop

Proves: User Story 2 scenarios 4 and 5, FR-015, FR-024.

Steps:
1. Set scenario `manual`, book, enable, and call the sweep.
2. Note the session id, then run `yarn workspace @calcom/notetaker-bot tsx scripts/fake-events.ts --session <id> --until passages` (script added by this feature; it posts the admitted event and one batch of transcript passages).
3. Press Stop in the app.
4. Post the end event with the same script, using end reason `STOP_REQUESTED`.
5. Try to enable the notetaker again on that booking.

Expected: the status is ended early (`ENDED_EARLY`) with the reason stopped by host (`STOPPED_BY_HOST`). The partial transcript is kept and labelled as ended early at the host's request. The fake gateway records a stop request, the notetaker does not rejoin, and turning the notetaker on again is refused. Variant: stopping before any speech was captured (use `--until admitted`) ends as failed (`FAILED`) with the reason stopped by host and no transcript.

### 5. Summary and its failure modes

Proves: User Story 3 scenarios 1 to 4, FR-018, FR-019, FR-022.

Steps:
1. On a `happy` booking, open the ready results.
2. Run a `no_speech` booking.
3. Force a generator failure on a `happy` booking (for example run with `ANTHROPIC_API_KEY` set to an invalid value), then use "Request summary again". That action is available when the summary failed or is missing, and not while it is pending, ready or not enough content.

Expected:
- Ready results show overview, key points, decisions and action items above the transcript.
- `no_speech` gives failed with the reason no speech detected, and no summary.
- On generator failure the transcript is still visible, the summary status is `FAILED`, and "Request summary again" works once the generator succeeds.

### 6. Failure reasons, admit prompt and incomplete transcripts

Proves: User Story 4 scenarios 1 to 4, FR-011, FR-023, FR-024, FR-025.

Steps:
1. Run `not_admitted`. While the session is waiting, check for the admit prompt.
2. Run `interrupted`.
3. Run `length_limit`.

Expected:
- While waiting, the admit prompt appears in the app and by email.
- `not_admitted` ends failed with the reason not admitted and no transcript, and the failed email is sent.
- `interrupted` (with captured content) ends as ended early, labelled incomplete with the interruption point shown.
- `length_limit` (with captured content) ends ready with the reason length limit reached, labelled truncated.
- Each enabled booking that yields no complete transcript shows exactly one status with a specific reason.

### 7. Event-type default and disclosure

Proves: User Story 5 scenarios 1 to 5, FR-002, FR-004, FR-014.

Steps:
1. In the event type settings, turn the notetaker default on.
2. Open the public booking page and look before confirming.
3. Book, and open the new booking.
4. Turn the default off and reopen the earlier booking.
5. Open an event type with only in-person locations.
6. Book with a guest attendee (not the person who booked) added, and check that guest's mail log.

Expected:
- The public booking page shows the disclosure before confirm.
- The new booking has the notetaker on, with source "event type default".
- A guest attendee on a booking that inherited the default receives the attendee notice.
- After the default is turned off, the existing booking is unchanged.
- The in-person event type shows the setting disabled, with an explanation.

### 8. Sharing, export, delete and activity

Proves: User Story 6 scenarios 1 to 6, FR-021, FR-026, FR-027, FR-028, FR-029, FR-031.

Steps:
1. On a ready booking, share with attendees.
2. Sign in as a user whose email matches an attendee and open the results. Then try as an unrelated user.
3. Revoke sharing and retry as the attendee.
4. As host, export.
5. As host, delete the results.
6. Open the activity list.

Expected:
- The matching attendee can open the transcript and summary; the unrelated user gets 403.
- After revoking, the attendee gets 403.
- Export downloads a Markdown file with the summary and the speaker-attributed transcript.
- After delete, the results are gone for everyone and the booking shows they were deleted.
- The activity list shows enable, share, revoke, export and delete, each with actor and time.

### 9. Booking lifecycle

Proves: FR-006, and the edge cases for reschedule, cancel and location change.

Steps:
1. Reschedule an enabled booking, then call the sweep.
2. Cancel an enabled booking, then call the sweep.
3. Change an enabled booking's location to in-person.
4. With the bot unreachable (for example the gateway failing every join request), enable a booking, call the sweep, and move past the give-up deadline (lower `NOTETAKER_NO_SHOW_TIMEOUT_SECONDS` to speed this up), then call the sweep again.

Expected:
- The new booking carries the choice and is enabled; the old one is never dispatched.
- The cancelled booking is never dispatched and any pending session is cancelled.
- For a location changed to an unsupported one, the choice is turned off and the turned-off email is sent to the enabling host.
- An unreachable bot ends as failed with the reason interrupted once the give-up deadline passes, and a failure email is sent. It never fails silently (SC-008).

### 10. Compatibility

Proves: FR-032, FR-033, SC-011.

Steps:
1. Open a booking whose location is Cal Video.
2. Run `git diff --stat -- docs/api-reference/v2/openapi.json` after implementing the feature.
3. Run the existing webhook unit tests.

Expected:
- The Cal Video booking shows the notetaker as unavailable, with a pointer to built-in transcription; built-in transcription behaves as before.
- No diff in `docs/api-reference/v2/openapi.json`.
- Existing webhook tests pass unchanged. See [public-api.md](./contracts/public-api.md).

### 11. Event contract

Proves: FR-008, FR-011, and the bot-to-app contract in [bot-events-webhook.md](./contracts/bot-events-webhook.md).

Steps:
1. Using `manual` and `fake-events.ts`, post an event with a wrong signature.
2. Post the same event twice with the same `eventId` and `sequence`.
3. Delete the results of an ended session (or use an unknown session id) and post another event for it.
4. End a session after admission so it reaches `PROCESSING`, then post another event for it.

Expected:
- A bad signature or a stale timestamp gets 401.
- The replay gets 200 and no duplicate passages are stored.
- The event for a deleted, terminal or unknown session gets 410, which tells the bot to leave.
- An event posted after the session reached `PROCESSING` gets 410 and changes nothing.

## Automated checks

```bash
yarn type-check:ci --force
yarn lint:fix
TZ=UTC yarn test
TZ=UTC yarn test packages/features/notetaker
VITEST_MODE=integration yarn test notetaker
```

The E2E spec runs with the fake provider. The file `apps/web/playwright/notetaker.e2e.ts` is added by this feature and holds one `test.describe("Notetaker")` with three tests: "host enables the notetaker and reads transcript and summary", "host shares and revokes attendee access", and "event-type default enables new bookings and discloses on the booking page".

```bash
NOTETAKER_BOT_PROVIDER=fake yarn e2e apps/web/playwright/notetaker.e2e.ts
```

The E2E file skips itself unless `NOTETAKER_BOT_PROVIDER=fake`, and the server it runs against needs `CRON_API_KEY`, `NOTETAKER_BOT_SECRET` and `NEXT_PUBLIC_IS_E2E=1`.

Running the E2E suite needs explicit approval under the project constitution. Do not start it without that approval. Bot runner tests (state machine and timers against `FakePlatformAdapter` and `FakeSpeechToTextProvider`) live in `apps/notetaker-bot` and run with that package's test script.

### Service-level walk-through

Three integration tests walk the scenario steps that need no browser. They drive the real services, repositories, sync tasker and stub summary generator, with a fake bot the test owns and the email service mocked:

- `packages/features/notetaker/tests/quickstartCore.integration-test.ts` (scenarios 1, 2, 3, 5, 6, 10)
- `packages/features/notetaker/tests/quickstartLifecycle.integration-test.ts` (scenarios 7, 8, 9)
- `apps/web/app/api/notetaker/events/__tests__/route.integration-test.ts` (scenarios 4 and 11, through the events route handler)

They run only against a throwaway database. Each file skips itself unless `NOTETAKER_IT_ISOLATED_DB=1` is set and `DATABASE_URL` points at `localhost:5547/calendso_it`. Load an env file that sets both before the command (on the development machine: `.ai/tmp/notetaker/it.env`):

```bash
set -a; . .ai/tmp/notetaker/it.env; set +a; VITEST_MODE=integration TZ=UTC yarn vitest run \
  packages/features/notetaker/tests/quickstartCore.integration-test.ts \
  packages/features/notetaker/tests/quickstartLifecycle.integration-test.ts \
  apps/web/app/api/notetaker/events/__tests__/route.integration-test.ts \
  --no-file-parallelism --exclude '.ai/**' --exclude '.herdr-web-ui/**'
```

The tests create their own users, event types and bookings and delete exactly those rows. The sweep runs in two cases of scenario 9 only (a pending session cancelled by the sweep; a bot unreachable until the give-up deadline), which is why the database must be isolated and the files run one after another. Everywhere else "call the sweep" is a dispatch for that one booking.

Not covered, and left to a person with a running app:

- Scenario 1: the toggle and badge in the booking sheet, the page rendering, the status passing through the intermediate labels, the sweep through HTTP.
- Scenario 3: the rejoin-blocked text in the UI.
- Scenario 4: pressing Stop in the app; running `apps/notetaker-bot/scripts/fake-events.ts` over HTTP.
- Scenario 5: forcing the failure with an invalid `ANTHROPIC_API_KEY`, and the "Request summary again" button.
- Scenario 6: the admit banner and the labels in the UI.
- Scenario 7: the advanced-tab toggle, the disclosure on the public page, the real booking flow.
- Scenario 8: the 403 as rendered, the file download, the deleted notice.
- Scenario 10: how the booking section shows a Cal Video booking; the diff and webhook checks.
- Scenario 11: posting with `fake-events.ts` over HTTP.

## Not covered here

- Real Google Meet and Microsoft Teams joins. The bot adapters need manual or nightly smoke tests against real meetings, outside CI.
- Speaker-attribution accuracy (SC-005). It depends on a spike with the chosen speech-to-text provider and a reviewed sample of real meetings.
