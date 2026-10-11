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
  unavailableReason: null | "FEATURE_DISABLED" | "NOT_A_TEAM_EVENT_TYPE" | "NO_TEAM_TO_SHARE_WITH",
  mode: "HOSTS_ONLY" | "TEAM" | "SELECTED_PEOPLE",
  teamName: string | null,
  teamId: number | null,
  teamOptions: { teamId: number, name: string }[],
  people: { userId: number, name: string | null, email: string, avatarUrl: string | null, stillEligible: boolean }[],
  setAt: string | null,        // ISO 8601 UTC
  setByName: string | null
}
```

`mode` is the stored mode; for a personal event type it has effect only while `teamId` is not null. For a personal event type the caller must be its owner.

`stillEligible` is false for a listed person who is no longer an accepted member of the organization or team; such a person has no access and is shown so an admin can remove them.

### `setEventTypeSharing({ eventTypeId, mode, userIds?, teamId? })` (mutation)

- `mode`: one of the three modes. `userIds`: 0 to 50 distinct ids; when omitted the stored list is kept.
- `teamId` is used for a personal event type only. For a team event type a `teamId` that differs from the event type's team is refused (`TEAM_NOT_ALLOWED`); an equal one is ignored.
- Refusals: no team resolved and `mode` is not `HOSTS_ONLY` (bad request, `TEAM_REQUIRED`); for a personal event type, a `teamId` that is not a team the owner is an accepted member of (bad request, `TEAM_NOT_ALLOWED`, naming no team), the owner in no team (`NO_TEAM_TO_SHARE_WITH`), and a caller who is not the owner (forbidden); a `userId` that is not an accepted member of the organization or team (bad request, naming no user); feature disabled (forbidden).
- Effects: stores the mode, replaces the list when `userIds` is given, writes one `EventTypeNotetakerSharingChange` when anything changed, and nothing when nothing changed.
- A different team replaces the list (by `userIds`, or empties it) and the change row carries both team names.
- Returns the same DTO as `getEventTypeSharing`.
- Takes effect for access on the next request (FR-014). It does not change `colleagueSharingDisclosed` on any existing session.

### `listEventTypeSharingCandidates({ eventTypeId, teamId?, search?, cursor?, limit? })` (query)

- For a personal event type: accepted members of `teamId` (default: the stored team).
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
| Member of the team chosen on a personal event type | yes | `TEAM` | viewer and owner accepted in that team | `SHARED_VIEWER` |
| Same | yes | `TEAM` | owner left the chosen team | refused |
| Same | yes | `TEAM` | chosen team deleted | refused |
| Member of another team of the owner | yes | `TEAM` | not in the chosen team | refused |
| Listed person, personal event type | yes | `SELECTED_PEOPLE` | viewer and owner accepted in the chosen team | `SHARED_VIEWER` |
| Listed person, personal event type | yes | `SELECTED_PEOPLE` | viewer left the chosen team | refused |
| Anyone | any | any | event type has no team and no chosen team | host and attendee rules only |

A refusal uses the existing message and does not say whether results exist.

## Pages

- `/booking/[uid]/notetaker`: unchanged route and session check; renders for the new role with view and export only, and shows the access statement to hosts.
- `/bookings/shared-notes` (new): the "Shared with me" list. The session check is in `page.tsx`.
- Event type editor, Advanced tab: the sharing control sits under the existing notetaker default. The sharing control is rendered for team event types and for personal event types whose owner belongs to at least one team.
