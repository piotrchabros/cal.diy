# Contract: tRPC `viewer.notetaker`, sharing additions

Extends `specs/001-meeting-transcription/contracts/trpc-notetaker.md`. Existing procedures keep their inputs; outputs only gain fields. Errors from services are `ErrorWithCode` and reach the client through the existing conversion.

## Changed outputs

### `getState({ bookingUid })`

- `viewerRole`: `"HOST" | "ATTENDEE" | "SHARED_VIEWER"`.
- `transcript.speakerNamesAvailable`: `boolean | null`.
- `access` (present only for `HOST`):

```text
access: {
  attendees: boolean,                       // same value as sharedWithAttendees
  colleagues: null
    | { route: "TEAM", teamName: string }
    | { route: "SELECTED_PEOPLE", people: { name: string }[] }   // at most 50
}
```

`access.colleagues` is null when the session was not disclosed for sharing or the mode is `HOSTS_ONLY`.

For `SHARED_VIEWER`: `choice` is null, `canToggle` and `canStop` are false, `featureEnabled` follows the rule used for attendees, and the first call per user and booking records a `SHARED_VIEWED` activity.

### `listPassages`, `export`

Allowed for `SHARED_VIEWER`. Unchanged otherwise. The export contains the names-unavailable sentence when `speakerNamesAvailable` is false.

### `setEnabled`, `stop`, `regenerateSummary`, `setSharing`, `deleteResults`, `getActivity`

Host only, as today. A `SHARED_VIEWER` receives the existing host-only refusal.

### `getActivity({ bookingUid })`

Entries may now have the actions `SHARED_VIEWED`, `SHARING_MODE_CHANGED` and `SHARING_PEOPLE_CHANGED`. The last two carry `detail: { previousMode, newMode, addedUserNames, removedUserNames }`.

### `public.notetakerDisclosure`

Gains `sharedWithColleagues: boolean`. The booking form shows the wider wording when it is true.

## New procedures

All three event-type procedures use `eventOwnerProcedure` (for a team event type: team role ADMIN or OWNER).

### `getEventTypeSharing({ eventTypeId })` (query)

Returns `NotetakerEventTypeSharingDto`:

```text
{
  eventTypeId: number,
  available: boolean,
  unavailableReason: null | "FEATURE_DISABLED" | "NOT_A_TEAM_EVENT_TYPE",
  mode: "HOSTS_ONLY" | "TEAM" | "SELECTED_PEOPLE",
  teamName: string | null,
  people: { userId: number, name: string | null, email: string, avatarUrl: string | null, stillEligible: boolean }[],
  setAt: string | null,        // ISO 8601 UTC
  setByName: string | null
}
```

`stillEligible` is false for a listed person who is no longer an accepted member of the organization or team; such a person has no access and is shown so an admin can remove them.

### `setEventTypeSharing({ eventTypeId, mode, userIds? })` (mutation)

- `mode`: one of the three modes. `userIds`: 0 to 50 distinct ids; when omitted the stored list is kept.
- Refusals: not a team event type and `mode` is not `HOSTS_ONLY` (bad request); a `userId` that is not an accepted member of the organization or team (bad request, naming no user); feature disabled (forbidden).
- Effects: stores the mode, replaces the list when `userIds` is given, writes one `EventTypeNotetakerSharingChange` when anything changed, and nothing when nothing changed.
- Returns the same DTO as `getEventTypeSharing`.
- Takes effect for access on the next request (FR-014). It does not change `colleagueSharingDisclosed` on any existing session.

### `listEventTypeSharingCandidates({ eventTypeId, search?, cursor?, limit? })` (query)

- Accepted members of the organization that owns the event type's team, or of the team when it has no organization. `limit` 1 to 50, default 20.
- Returns `{ items: { userId, name, email, avatarUrl }[], nextCursor: string | null }`.

### `listSharedWithMe({ cursor?, limit? })` (query, `authedProcedure`)

- Results the caller can read as `SHARED_VIEWER` and that have a transcript, newest meeting first. `limit` 1 to 50, default 20.
- Returns `{ items: NotetakerSharedResultDto[], nextCursor: string | null }`:

```text
{ bookingUid, title, startTime, eventTypeTitle, teamName, hostName, route: "TEAM" | "SELECTED_PEOPLE", summaryStatus }
```

- Bookings where the caller is a host or an attendee are not listed here; they are in the bookings list already.

## Access matrix

| Viewer | Session disclosed | Mode | Membership | Result |
|--------|-------------------|------|------------|--------|
| Host | any | any | any | `HOST` |
| Attendee with grant and verified email | any | any | any | `ATTENDEE` |
| Team member | yes | `TEAM` | accepted in the team | `SHARED_VIEWER` |
| Team member | yes | `TEAM` | removed or not accepted | refused |
| Team member | no | `TEAM` | accepted | refused |
| Listed person | yes | `SELECTED_PEOPLE` | accepted in the organization (or team) | `SHARED_VIEWER` |
| Listed person | yes | `SELECTED_PEOPLE` | left the organization (or team) | refused |
| Listed person | yes | `TEAM` or `HOSTS_ONLY` | any | refused unless covered by the row above for `TEAM` |
| Team admin, not a host | yes | `HOSTS_ONLY` | any | refused |
| Anyone | any | any | event type has no team | host and attendee rules only |

A refusal uses the existing message and does not say whether results exist.

## Pages

- `/booking/[uid]/notetaker`: unchanged route and session check; renders for the new role with view and export only, and shows the access statement to hosts.
- `/bookings/shared-notes` (new): the "Shared with me" list. The session check is in `page.tsx`.
- Event type editor, Advanced tab: the sharing control sits under the existing notetaker default. It is rendered only for team event types.
