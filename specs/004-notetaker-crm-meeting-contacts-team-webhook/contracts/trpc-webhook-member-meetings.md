# Contract: tRPC `viewer.webhook`, the member-meetings flag

Existing procedures keep their inputs; `create` and `edit` gain one optional field; outputs gain one field. Errors are `TRPCError`.

## Terms

- **Flagged webhook**: `includeMemberMeetings = true`.
- **Team-owned webhook**: `userId` null, `teamId` set, `eventTypeId` null. Every flagged webhook is team-owned; a team-owned webhook stays team-owned after the flag is turned off.
- **Team admin**: `MembershipRepository.getAdminOrOwnerMembership(userId, teamId)` returns a membership (accepted ADMIN or OWNER).

## Guards (`memberMeetings.ts`)

- `assertMemberMeetingsScope({ teamId, platform, eventTypeId })`: `BAD_REQUEST` "includeMemberMeetings is only available for team webhooks" when `teamId` is null, `platform` is true or `eventTypeId` is set; `BAD_REQUEST` "includeMemberMeetings is not available for organizations" when the team does not exist or `isOrganization`. Returns the team id.
- `assertTeamAdminForMemberMeetings({ userId, teamId })`: `FORBIDDEN` unless the caller is a team admin of `teamId`.

## `createWebhookProcedure` (applies to `list`, `get`, `create`, `edit`, `delete`, `testTrigger`, `getByViewer` when an `id` is given)

Unchanged for user-owned and event-type webhooks. New branch: a webhook with no `userId` and a `teamId` requires the caller to be a team admin of that team (`FORBIDDEN` otherwise).

## `create`

- Input gains `includeMemberMeetings?: boolean`.
- When true: `assertMemberMeetingsScope(input)` then `assertTeamAdminForMemberMeetings`; the created row does **not** connect the creating user (`userId` null). When false or absent: exactly the previous behaviour, including connecting the user for non-platform, non-event-type webhooks.
- `updateTriggerForExistingBookings` runs as before; for a flagged webhook the backfill includes the members' shared bookings (see `member-meetings-delivery.md`).

## `edit`

- Input gains `includeMemberMeetings?: boolean`.
- Order of checks after the existing ownership lookup:
  1. The stored webhook is flagged → caller must be a team admin.
  2. The stored webhook is team-owned, or the resulting flag is true, and the input changes `teamId` or `eventTypeId` → `BAD_REQUEST` "The team or event type of a team webhook cannot be changed".
  3. The resulting flag (`input.includeMemberMeetings ?? stored`) is true → `assertMemberMeetingsScope` on the resulting team/platform/event type, then team admin.
- Update: the input data; when the flag goes from false to true, `userId` is set to null. Turning it off never re-attaches a user.
- Scheduled rows: when `data.active`, `updateTriggerForExistingBookings(updatedWebhook, previousActiveTriggers, updatedTriggers, previousIncludeMemberMeetings)` where the 4th argument is the stored flag if the webhook was active before, else undefined. A changed flag triggers reconciliation of the members' MEETING_* rows.

## `delete`

- First lookup unchanged (`id` with the caller's `userId`, or the event type's webhook). If nothing is found and no `eventTypeId` was given, a second lookup finds a team-owned webhook by `id`; the caller must be a team admin of its team (`FORBIDDEN` otherwise).
- Not found by either lookup → `NOT_FOUND` (before: silent `{ id }`).
- Deletion and `updateTriggerForExistingBookings(webhook, triggers, [])` unchanged.

## `get`, `testTrigger`

Unchanged handlers; access is decided by `createWebhookProcedure` above, so a plain member cannot read a team-owned webhook's secret or fire a test from it.

## `list`

`WebhookRepository.listWebhooks` adds, for the caller: webhooks with a user, without a team, or with an event type are listed as before; team-owned webhooks are listed only for teams where the caller is an accepted ADMIN or OWNER.

## `getByViewer`

In the per-team lists, team-owned webhooks are omitted unless the caller's membership in that team is ADMIN or OWNER. User-owned team webhooks are listed as before (see the known gap in `spec.md`).

## Outputs

Every webhook output (`findByWebhookId`, `listWebhooks`, `getByViewer`, the DTO `Webhook`) gains `includeMemberMeetings: boolean`.

## UI (`WebhookForm`, new and edit views and pages)

- The switch "Include meetings of all team members" (`webhook_include_member_meetings`, description `_description`) renders only when the form gets a `teamId` (team scope, not platform).
- It is disabled with `webhook_include_member_meetings_admin_only` when `canManageMemberMeetings` is false; the pages compute that from the caller's membership role (`new`: from `?teamId=`; `[id]`: from the webhook's team).
- The views send `includeMemberMeetings` only when the switch is applicable and the caller can manage it; otherwise the field is omitted so existing webhooks are not touched.
