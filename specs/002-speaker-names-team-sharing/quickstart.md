# Quickstart: validating Speaker Names and Team Sharing

**Spec**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/) | **Data model**: [data-model.md](./data-model.md)

This checkout serves a live site and its `.env` points at the live database. Automated checks that write to a database run only against the scratch container (`caldiy-e2e-pg`, 127.0.0.1:5547). Nothing below runs a build in `apps/web` or a Prisma command against the live database; those happen only in the deployment step, with the owner's go-ahead.

## Automated checks

```bash
yarn type-check:ci --force
TZ=UTC yarn vitest run apps/notetaker-bot packages/features/notetaker packages/lib/notetaker packages/lib/dto \
  packages/trpc/server/routers/viewer/notetaker apps/web/modules/notetaker \
  --exclude '.ai/**' --exclude '.herdr-web-ui/**'
yarn biome check apps/notetaker-bot packages/features/notetaker packages/lib packages/trpc/server/routers/viewer/notetaker apps/web/modules/notetaker
```

Integration and E2E, scratch database only (environment files as used for the first specification):

```bash
docker start caldiy-e2e-pg
# integration: the new repository methods and the access matrix against real tables
VITEST_MODE=integration TZ=UTC yarn vitest run packages/features/notetaker --exclude '.ai/**' --exclude '.herdr-web-ui/**'
# E2E: the notetaker file only
PLAYWRIGHT_HEADLESS=1 yarn e2e apps/web/playwright/notetaker.e2e.ts
docker stop caldiy-e2e-pg
```

Expected: no type errors; all listed tests pass; Biome reports no errors.

## Scenario 1: measurement run (before any speaker code, research A1)

Prerequisites: a Google Meet with the notetaker account invited and two people who can speak.

1. Tell the participants that a diagnostic tool will join for two minutes and records page structure and audio levels only.
2. Run `yarn workspace @calcom/notetaker-bot meet-probe "<meeting url>" --out /root/meet-probe-speech.json --duration 120` with the bot environment loaded.
3. Person A speaks for 20 seconds, then person B for 20 seconds, then silence for 10 seconds; repeat once.

Expected in the report: verdicts for the three questions of research A1 (tile source equals an audio source that rises with speech; a per-tile indicator that follows speech; source timestamps on the page clock). The verdicts decide the signal order before implementation continues. The report contains no names, audio or chat.

## Scenario 2: named speakers in a real meeting (User Story 1)

1. Book a Google Meet event with the notetaker on. Join with three people; each says a few sentences in turn, twice.
2. End the meeting and open `/booking/<uid>/notetaker`.

Expected: each passage carries the name the participant had in Meet; the same person has one name throughout; a passage spoken over someone else may show "Unknown speaker N" but never another participant's name; the notetaker account is not a speaker; the summary's action items use the same names; the export matches.

Record the reviewed share of correct passages in `apps/notetaker-bot/docs/verification-status.md` (SC-001, SC-002).

## Scenario 3: names unavailable (FR-007)

Run the fake bot with a script whose final event has `speakerNamesAvailable: false` (unit and E2E fixtures cover this). Expected: numbered labels and one sentence on the results page and in the export saying names were unavailable.

## Scenario 4: whole-team sharing (User Story 2)

Accounts: admin A, member B and member C of one team; outsider D.

1. As A, open a team event type, Advanced tab, and set notetaker sharing to "Whole team".
2. Book the event type with B as host and hold a transcribed meeting (fake bot is enough).
3. As C, open "Shared with me" under bookings and open the result.
4. As D, open the result's address directly.
5. As A, remove C from the team; as C, reload the result.
6. As A, set sharing back to "Hosts only"; as any other member, reload.

Expected: C reads and exports in step 3 and has no delete, share or stop control; D is refused in step 4; C is refused in step 5; every non-host is refused in step 6. A result of a meeting held before step 1 is refused for C at every step.

## Scenario 5: selected people (User Story 3)

1. As A, set sharing to "Selected people" and pick E, a member of the organization who is not in the team.
2. Hold a transcribed meeting hosted by B.

Expected: E reads the result; C (a team member, not selected) is refused; after A removes E from the list, E is refused; a person who is not a member of the organization cannot be found in the picker.

## Scenario 6: transparency (User Story 4)

1. With sharing on, open the public booking page of the event type.
2. Hold the meeting and read the notice the notetaker posts in the chat.
3. As host B, open the result.

Expected: the booking form and the chat notice both say that colleagues of the host may read the transcript and summary; the result shows who has access (team name or the selected names); the activity history lists the sharing change by A and the first view by C or E.

## Deployment check

After the owner approves the migration and the in-place rebuild: apply the one additive migration, rebuild, install the new bot bundle, restart the bot service when no meeting is running, then repeat Scenario 2 and steps 1 to 4 of Scenario 4 on the live site.
