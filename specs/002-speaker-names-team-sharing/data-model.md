# Data Model: Notetaker Speaker Names and Team Sharing

**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

All changes are additive. No column is renamed or removed, and every new column has a default or is nullable, so rows written before this feature stay valid.

## Changed models

### `EventTypeNotetakerSettings` (existing)

| Field | Type | Default | Note |
|-------|------|---------|------|
| `sharingMode` | `NotetakerSharingMode` | `HOSTS_ONLY` | Mode in force for results of this event type (FR-009) |
| `sharingSetByUserId` | `Int?` | null | Soft reference, like other actor columns in this slice |
| `sharingSetAt` | `DateTime?` | null | When the mode last changed; shown in settings, not used for access |

Rule: `sharingMode` other than `HOSTS_ONLY` is accepted only when the event type has a team (`EventType.teamId` is set). Enforced in the service.

### `NotetakerSession` (existing)

| Field | Type | Default | Note |
|-------|------|---------|------|
| `colleagueSharingDisclosed` | `Boolean` | `false` | Set at dispatch when the event type's mode was not `HOSTS_ONLY`, together with the wider in-meeting notice. Never changed afterwards (research B2) |

### `NotetakerTranscript` (existing)

| Field | Type | Default | Note |
|-------|------|---------|------|
| `speakerNamesAvailable` | `Boolean?` | null | null: made before this feature. false: no participant could be identified. true: at least one participant was identified (FR-007) |

### `NotetakerTranscriptPassage` (existing, no schema change)

- `speakerKey` stays an opaque string. New values look like `participant:<hash>`; stored values `unknown:<n>` and `participant:name:<x>` stay valid (FR-008).
- `speakerName` may now carry a duplicate-name suffix chosen by the bot ("Anna Nowak (2)").
- The rule that exactly one of `speakerName` and `unknownSpeakerNumber` is set is unchanged.
- New repository operation: replace `speakerKey`, `speakerName` and `unknownSpeakerNumber` for all passages of one transcript that have a given `speakerKey` (used once, at finalize, for the bot's resolutions).

### Enum `NotetakerActivityAction` (existing)

Adds `SHARED_VIEWED` (first view of a result by a person whose access comes from the sharing mode).

## New enum

### `NotetakerSharingMode`

`HOSTS_ONLY` | `TEAM` | `SELECTED_PEOPLE`

## New models

### `EventTypeNotetakerSharingMember`

One selected person on one event type's list.

| Field | Type | Note |
|-------|------|------|
| `eventTypeId` | `Int` | FK to `EventType`, cascade on delete |
| `userId` | `Int` | FK to `User`, cascade on delete |
| `addedByUserId` | `Int?` | Soft reference |
| `addedAt` | `DateTime` | default now |

- Primary key `(eventTypeId, userId)`; index on `userId` for the "shared with me" query.
- Validation (service): the user is an accepted member of the organization that owns the event type's team, or of the team itself when it has no organization (FR-012). At most 50 people per event type.
- A row grants access only while the mode is `SELECTED_PEOPLE` and the membership rule still holds (FR-013).

### `EventTypeNotetakerSharingChange`

History of the setting (FR-023).

| Field | Type | Note |
|-------|------|------|
| `id` | `String` (uuid) | Primary key |
| `eventTypeId` | `Int` | FK to `EventType`, cascade on delete |
| `actorUserId` | `Int?` | Soft reference |
| `actorName` | `String?` | Name at the time, so the entry survives a deleted account |
| `previousMode` | `NotetakerSharingMode` | |
| `newMode` | `NotetakerSharingMode` | Equal to `previousMode` when only the list changed |
| `addedUserNames` | `String[]` | Names at the time |
| `removedUserNames` | `String[]` | Names at the time |
| `createdAt` | `DateTime` | default now |

- Index `(eventTypeId, createdAt)`.
- A booking's activity history shows the changes of its event type made at or after the creation of that booking's first session.

## Derived concepts (not stored)

### Access route

Computed per request by `NotetakerAccessService`, in this order:

1. `HOST`: unchanged rule (organizer, or an event-type host who attends the booking).
2. `ATTENDEE`: unchanged rule (sharing grant on the booking and a verified email on the attendee list).
3. `SHARED_VIEWER`: the result's session has `colleagueSharingDisclosed = true`, the event type has a team, and
   - mode `TEAM` and the user is an accepted member of that team, or
   - mode `SELECTED_PEOPLE`, the user is on the list, and the user is an accepted member of the team's organization (or of the team when it has no organization).
4. Otherwise refused with the existing message.

### Speaker resolution (wire only)

Sent once by the bot in its final event; applied to passages and not stored on its own. See [contracts/bot-contract-speakers.md](./contracts/bot-contract-speakers.md).

## DTO changes (`packages/lib/dto`)

| DTO | Change |
|-----|--------|
| `NotetakerStateDto` | `viewerRole` gains `"SHARED_VIEWER"`; new optional `access` object for hosts (see the tRPC contract); `transcript` gains `speakerNamesAvailable: boolean \| null` |
| `NotetakerActivityDto` | action union gains `"SHARED_VIEWED"`, `"SHARING_MODE_CHANGED"`, `"SHARING_PEOPLE_CHANGED"` (the last two are produced from `EventTypeNotetakerSharingChange`) |
| `NotetakerEventTypeSharingDto` (new) | `eventTypeId`, `available`, `unavailableReason`, `mode`, `people[]` (`userId`, `name`, `email`, `avatarUrl`, `stillEligible`), `teamName`, `setAt`, `setByName` |
| `NotetakerSharedResultDto` (new) | one row of the "shared with me" list: `bookingUid`, `title`, `startTime`, `eventTypeTitle`, `teamName`, `hostName`, `route` (`TEAM` or `SELECTED_PEOPLE`), `summaryStatus` |
| `NotetakerDisclosureDto` | gains `sharedWithColleagues: boolean` |

Enums in DTOs are string literal unions, not Prisma enums.

## Migration

One migration, `add_notetaker_event_type_sharing_and_speaker_names`: the new enum, the three new columns, the two new tables, and the new enum value on `NotetakerActivityAction`. No data backfill is needed. No new feature flag.
