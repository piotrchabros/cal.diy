# Quickstart: meeting contacts and the team webhook

**Spec**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/) | **Data model**: [data-model.md](./data-model.md)

This checkout is a worktree (`/root/cal.diy-crm-webhook`). `/root/cal.diy` is the deploy source and is never touched. No migration runs against a real database from here; `yarn prisma generate` is allowed.

## Automated checks

```bash
yarn prisma generate
TZ=UTC yarn test packages/features/notetaker
TZ=UTC yarn test packages/features/webhooks/lib
TZ=UTC yarn test packages/features/bookings/lib
TZ=UTC yarn test packages/trpc/server/routers/viewer/webhook packages/trpc/server/routers/viewer/notetaker packages/trpc/server/routers/viewer/bookings
TZ=UTC yarn test apps/web/modules/notetaker apps/web/modules/webhooks
yarn type-check:ci --force
yarn biome check --write <changed files>
```

Expected: no type errors; all tests pass; Biome reports no errors. The contact repository integration test runs only against the scratch database.

## Deployment (owner only)

1. Apply the two migrations (`20261106000000_add_notetaker_meeting_contact`, `20261106000001_add_webhook_include_member_meetings`) with the usual deploy procedure; they are additive.
2. Rebuild; `yarn prisma generate` is part of the build.
3. Keep the `webhookTriggers` cron from `specs/003/quickstart.md`; MEETING_* rows of team webhooks depend on it.

## For a team admin: connect the team to the CRM with one webhook

1. In cal.diy open the team's settings, Webhooks (or Settings, Developer, Webhooks and choose the team) and create a new webhook. You must be an admin or owner of the team; members see the switch below disabled.
2. Subscriber URL: `https://<crm-host>/api/webhooks/inbound/calcom`. Secret: the CRM tenant's `webhookSecret`. No custom payload template, no Zapier.
3. Triggers: `RECORDING_TRANSCRIPTION_GENERATED`; optionally `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_REQUESTED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`, `MEETING_STARTED`, `MEETING_ENDED`.
4. Turn on "Include meetings of all team members" and save. The webhook now belongs to the team (no personal owner) and only team admins/owners can open, edit, test or delete it.
5. Tell the members: a meeting reaches the CRM only when its notetaker results are shared with this team, i.e. the event type's notetaker sharing is set to this team (team event types: the team itself with sharing "whole team"; personal event types: "whole team" with this team chosen), or, for ad-hoc and calendar meetings, "Share with team" set to this team in the Add-to-meeting dialog or auto-join settings. Hosts-only and selected-people meetings never leave their host's own webhooks.
6. Do not also create per-user webhooks for the same CRM tenant for these members, or shared meetings arrive twice.

## For a host: customer emails on an ad-hoc meeting

1. Notetaker, Add to meeting: paste the link, pick "Share with team" if the team webhook should receive it, type the customer emails in "Customer emails (optional)" (commas or new lines), tick the notice, start.
2. On the booking page the "Customer emails" section lists the contacts; edit and save to replace the manual ones. Calendar-sourced ones show "From calendar invite" and are refreshed from your calendar until the meeting ends.
3. After the transcript was sent the section says changes will not be re-sent.

## Scenario 1: contacts reach the CRM, nobody is emailed

1. Add a meeting with `customer@client.example`; run it to completion with the fake bot.
2. The request catcher gets one transcript webhook with `attendees: [{ email: "customer@client.example", ... }]`, `source: "ad_hoc"`.
3. No email was queued for the contact; the contact cannot open the results URL; `/bookings` of a user with that email does not list the meeting.

## Scenario 2: calendar invitees

1. With auto-join on, create a Google (or Office 365) event with two external invitees with names, a colleague who is also a cal.diy participant, and a room resource.
2. After the sweep, `getState` for the host shows two `CALENDAR` contacts with names; the colleague and the room are absent.
3. Add an invitee before the meeting: the next sweep adds it. After the meeting ends, invite changes do nothing.

## Scenario 3: team webhook receives only shared meetings

1. Member M of team T books a personal event type whose notetaker sharing is "whole team T"; the flagged webhook of T receives `BOOKING_CREATED`, later `MEETING_STARTED`/`MEETING_ENDED` (cron) and the transcript.
2. M books a hosts-only event type: the flagged webhook receives nothing; M's own webhook does.
3. M is removed from T, then the first meeting's transcript settles: the flagged webhook does not receive it (MEETING_* rows already scheduled may still fire; known gap).
4. An unflagged team webhook of T for the same triggers receives, as before, only T's own event-type bookings.

## Scenario 4: access to the team webhook

1. As a plain member of T, list webhooks: the flagged webhook is not shown; `get`, `edit`, `testTrigger`, `delete` on its id are refused.
2. As an admin of T, all of them work; changing the team or adding an event type on edit is refused.
3. Turn the flag off and on again on an active webhook with `MEETING_ENDED`: the scheduled rows for members' future shared bookings disappear and reappear.

## Companion CRM check

In Open Mercato the transcript of a meeting whose attendee matches a person is attached to that person; a transcript with no matching attendee (for example `attendees: []`) appears in the unassigned-transcripts inbox, where it can be assigned or dismissed. `source` is shown on the inbox row.
