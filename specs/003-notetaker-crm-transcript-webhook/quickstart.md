# Quickstart: validating the transcript webhook

**Spec**: [spec.md](./spec.md) | **Contract**: [contracts/transcript-webhook.md](./contracts/transcript-webhook.md) | **Data model**: [data-model.md](./data-model.md)

This checkout is a worktree (`/root/cal.diy-crm-webhook`). `/root/cal.diy` is the deploy source and is never touched. No migration runs against a real database from here; `yarn prisma generate` is allowed.

## Automated checks

```bash
yarn prisma generate
TZ=UTC yarn test packages/features/notetaker
TZ=UTC yarn test packages/features/webhooks/lib
yarn type-check:ci --force
yarn biome check --write <changed files>
```

Expected: no type errors; all tests pass; Biome reports no errors.

## Subscribing a user webhook to the CRM

Each host does this once per CRM tenant. A team can instead use one flagged team webhook; that path is in [`specs/004/quickstart.md`](../004-notetaker-crm-meeting-contacts-team-webhook/quickstart.md). Use one of the two per host, not both, or the CRM receives each shared meeting twice.

1. In cal.diy open Settings, Developer, Webhooks, and create a webhook under the user's own account (not a team, event type or organization webhook).
2. Subscriber URL: `https://<crm-host>/api/webhooks/inbound/calcom`.
3. Triggers: tick `RECORDING_TRANSCRIPTION_GENERATED`. Tick the booking triggers (created, requested, rescheduled, cancelled, rejected) and `MEETING_ENDED` as well if the CRM should track the meeting itself.
4. Secret: enter the same secret that is stored in the CRM integration credentials (`webhookSecret`) for that tenant. Never leave it empty.
5. Do not set a custom payload template and do not use Zapier; the default payload carries the `notetaker` block.
6. Save and use the test ping if needed.

## MEETING_ENDED needs a cron

`MEETING_ENDED` is not produced by an event; cal.diy emits it from a scheduled job. A server cron (user approved) must call the cal.diy endpoint regularly, for example every 5 minutes:

```bash
curl -fsS -X POST -H "Authorization: $CRON_API_KEY" "https://<cal-host>/api/cron/webhookTriggers"
```

Use the cron key as the deployment expects (`CRON_API_KEY` header or query, as for the other cron endpoints). Without it the CRM never completes meetings; transcript delivery does not depend on it.

## Scenario 1: transcript is delivered once

1. With the subscription above pointing at a request catcher (or the CRM), run a notetaker meeting to completion.
2. Check one request arrived with `X-Cal-Signature-256` and `X-Cal-Webhook-Version: 2021-10-20`, the booking fields, `"source": "booking"` and the `notetaker` block.
3. Re-run summary generation for the same transcript; no second request arrives.

## Scenario 2: nothing is sent

- Delete the results (session `resultsDeletedAt` set): no request.
- Use a user without the webhook: no request.
- Subscribe an event-type webhook, or a team webhook without "include meetings of all team members", only: no request.

## Scenario 3: failing receiver

Point the webhook at a URL returning 500: the transcript, summary and status are saved as usual; the log shows ids only.

## Scenario 4: meeting without an event type (phase 2)

1. Open the notetaker's "Add to meeting" dialog, paste a Meet link, enter one customer email under "Customer emails (optional)", and start the bot; finish the meeting.
2. Check one request arrived whose payload has `"type": "notetaker_meeting"`, `"eventTypeId": null`, `"source": "ad_hoc"`, `organizer` = the host and `attendees` = the one customer email.
3. Repeat with a meeting joined from the calendar (auto-join on): `"source": "calendar_auto_join"`, attendees = the invitees of the calendar event minus cal.diy users and rooms.
4. Repeat with no customer email on an ad-hoc meeting: `attendees` is `[]`; the CRM queues it in its inbox.

## Companion CRM check

In Open Mercato (branch `feat/calcom-integration`, spec `.ai/specs/2026-11-04-calcom-crm-integration.md`) the transcript appears as a file on the person's record and the summary as a comment on the meeting interaction; a transcript with no matching person lands in the unassigned-transcripts inbox. The CRM inbound route must accept bodies of at least 2 MB for source `calcom`.
