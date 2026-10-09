# Contract: Web API (tRPC) — viewer.notetaker

Related: [../spec.md](../spec.md), [../data-model.md](../data-model.md)

This contract defines the web-facing tRPC surface of the meeting-transcription notetaker. The router lives at `packages/trpc/server/routers/viewer/notetaker/_router.tsx` as `viewer.notetaker`. Every procedure is an `authedProcedure`. The router only authenticates the caller; access is enforced in the services (`NotetakerAccessService` decides the viewer role). Services raise errors as `ErrorWithCode` (via `ErrorWithCode.Factory`) and the tRPC layer converts them; the router never constructs `TRPCError` for domain failures.

Roles used below:

- **HOST**: the booking organizer (`booking.userId`), or an event-type host/user who is also an attendee of the booking. Team and organization admins are not hosts.
- **ATTENDEE**: a signed-in user whose primary or verified secondary email matches an `Attendee.email` of the booking, and only while a `NotetakerSharingGrant` row exists for the booking.
- Anyone else is refused with Forbidden.

Who may call what: `getState`, `listPassages` and `export` are open to a HOST, or to an ATTENDEE while a grant exists. `setEnabled`, `stop`, `regenerateSummary`, `setSharing`, `deleteResults` and `getActivity` are HOST only; a granted attendee calling `getActivity` gets Forbidden. `getEventTypeDefault` and `setEventTypeDefault` use the existing `eventOwnerProcedure` (`packages/trpc/server/routers/viewer/eventTypes/util.ts`) instead of the booking roles: for a team event type the caller must be a team member with role `ADMIN` or `OWNER`; for a personal event type the caller must be the event type's `userId` or one of its `users`.

## Procedures

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `getState` | query | `{ bookingUid: string }` | `NotetakerStateDto` |
| `setEnabled` | mutation | `{ bookingUid, enabled: boolean, scope: "THIS_BOOKING" \| "ALL_FUTURE_OCCURRENCES" }` (default `THIS_BOOKING`) | `NotetakerStateDto` |
| `stop` | mutation | `{ bookingUid }` | `NotetakerStateDto` |
| `listPassages` | query | `{ bookingUid, sessionId?: string, cursor?: number, limit?: 1..500 }` (default 200) | `{ passages: NotetakerPassageDto[], nextCursor: number \| null }` |
| `regenerateSummary` | mutation | `{ bookingUid }` | `NotetakerSummaryDto` |
| `setSharing` | mutation | `{ bookingUid, shared: boolean }` | `{ sharedWithAttendees: boolean }` |
| `export` | mutation | `{ bookingUid, format: "markdown" }` | `{ filename: string, mimeType: "text/markdown", content: string }` |
| `deleteResults` | mutation | `{ bookingUid }` | `NotetakerStateDto` |
| `getActivity` | query | `{ bookingUid }` | `NotetakerActivityDto[]` |
| `getEventTypeDefault` | query | `{ eventTypeId: number }` | `{ enabledByDefault: boolean, available: boolean, unavailableReason: NotetakerIneligibilityReasonDto \| null }` |
| `setEventTypeDefault` | mutation | `{ eventTypeId: number, enabledByDefault: boolean }` | same shape as `getEventTypeDefault` |

Dates in outputs are ISO 8601 strings. Error kinds are listed in [Errors](#errors).

### getState

- **Purpose**: Returns everything the booking's notetaker panel needs: eligibility, the current choice, the single current status, the latest session, transcript metadata, summary and sharing flag. The UI polls it to drive the "please admit" banner.
- **Callable by**: HOST, or ATTENDEE with a sharing grant (the returned `viewerRole` says which).
- **Input**: `bookingUid: string`.
- **Output**: `NotetakerStateDto`. A cancelled or rejected booking is read as having a void choice.
  - `status` is the single displayed status, and the UI uses it. It is chosen in three steps: (1) `SCHEDULED` when the choice is enabled and `pendingDispatch` is true; (2) otherwise the latest session's status, if a session exists, whatever `enabled` is; (3) otherwise `null`. "Enabled, not pending, no session" is unreachable by invariant; `getState` returns `SCHEDULED` defensively.
  - `session.status` is the stored status of the latest session row. It differs from `status` only when the choice is re-armed after a terminal session.
  - `featureEnabled` is false when the feature flag is off for the user, or when the bot provider is unusable in production (provider unset, `fake` without `NEXT_PUBLIC_IS_E2E`, or `recall`, which is not built in v1). The reason is then `FEATURE_DISABLED`.
  - For an ATTENDEE, `choice` is null and `canToggle` and `canStop` are false.
- **Preconditions and errors**: the booking exists, otherwise NotFound; the caller is a HOST or a granted ATTENDEE, otherwise Forbidden.
- **Side effects**: none.
- **Satisfies**: FR-002, FR-023, FR-025, FR-026, FR-032. Acceptance: US1.1, US1.2, US4.1, US4.3.

### setEnabled

- **Purpose**: Turns the notetaker on or off for a booking, or for all future occurrences of a recurring booking. The most recent choice applies.
- **Callable by**: HOST only.
- **Input**:
  - `bookingUid: string`
  - `enabled: boolean`
  - `scope: "THIS_BOOKING" | "ALL_FUTURE_OCCURRENCES"`, default `THIS_BOOKING`. `ALL_FUTURE_OCCURRENCES` upserts the choice for bookings with the same `recurringEventId` and `startTime` at or after this booking's, and sets `appliedToSeries` to true on the affected rows in both directions. On a non-recurring booking it behaves as `THIS_BOOKING`, with no error. With `enabled: false` it disables this booking and every later occurrence that has not ended.
- **Output**: `NotetakerStateDto` after the change.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
  - When enabling, the booking is eligible (supported platform, not Cal Video, a usable meeting link or provisional location, feature enabled for the host, booking active), otherwise BadRequest carrying the `NotetakerIneligibilityReasonDto`.
  - When enabling, `booking.endTime` has not passed, otherwise BadRequest (`MEETING_ENDED`).
  - When enabling, `rejoinBlocked` is false, otherwise BadRequest (`REJOIN_BLOCKED`); it is set when a participant removed the notetaker in any phase, or a host stopped it after admission; it is not set by a pre-admission disable or stop.
- **Side effects**:
  - Writes a `NotetakerActivity` record with action `ENABLED` or `DISABLED`.
  - Off to on sets `pendingDispatch` to true. Enabling inside the `NOTETAKER_JOIN_LEAD_SECONDS` window dispatches immediately from the mutation; otherwise the scheduled sweep dispatches.
  - Off to on sends the `ATTENDEE_NOTICE` notification. Dedupe is per attendee: recipients are the current `Attendee.email` values minus the booking's own `BookingNotetaker.notifiedAttendeeEmails` and minus those of bookings sharing the same non-null `recurringEventId`. After sending, the recipients are appended to `notifiedAttendeeEmails` and `attendeesNotifiedAt` is set. Re-enabling therefore does not re-send to people already told, and disabling does not clear the list.
  - Disabling before admission requests a session stop with reason `DISABLED`; no transcript is created and no notice is sent.
- **Satisfies**: FR-001, FR-003, FR-005, FR-006, FR-008, FR-014, FR-031. Acceptance: US1.1, US1.4, US1.5, US2.1, US5.3.

### stop

- **Purpose**: Ends an in-progress session at the host's request; the notetaker then does not rejoin that meeting.
- **Callable by**: HOST only.
- **Input**: `bookingUid: string`.
- **Output**: `NotetakerStateDto` after the stop request.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
  - A session in `SCHEDULED`, `WAITING_TO_BE_ADMITTED` or `TRANSCRIBING` exists, otherwise BadRequest. A repeat call while a stop is already pending returns the state and writes no new activity.
- **Side effects**:
  - Writes a `NotetakerActivity` record with action `STOPPED`.
  - Requests the bot to stop with reason `STOPPED_BY_HOST` (the bot leaves within 10 seconds). Before admission, the pending session row is deleted: no transcript, no notice, and `rejoinBlocked` is not set (the host can turn the notetaker on again). After admission with passages, the session ends with `ENDED_EARLY` and outcome reason `STOPPED_BY_HOST`, the partial transcript is kept, and `rejoinBlocked` becomes true. After admission with no passages, the session ends with `FAILED` and outcome reason `STOPPED_BY_HOST`, there is no transcript, and `rejoinBlocked` becomes true.
- **Satisfies**: FR-015, FR-024, FR-031. Acceptance: US2.4, US2.5.

### listPassages

- **Purpose**: Returns the transcript passages in spoken order, cursor-paginated.
- **Callable by**: HOST, or ATTENDEE with a sharing grant.
- **Input**:
  - `bookingUid: string`
  - `sessionId?: string`. When omitted, the latest session of the booking that has a transcript is used.
  - `cursor?: number`. The `index` of the last passage of the previous page; the page starts after it (exclusive). `nextCursor` is the last returned `index`, or null.
  - `limit?: 1..500`, default 200.
- **Output**: `{ passages: NotetakerPassageDto[], nextCursor: number | null }`. Display order is by passage `index`.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST or a granted ATTENDEE, otherwise Forbidden. Revocation is immediate because every read checks the grant.
  - Results that were deleted are not returned. A missing transcript or deleted results give NotFound.
- **Side effects**: none.
- **Satisfies**: FR-009, FR-017, FR-026, FR-027, FR-028. Acceptance: US1.3, US6.1, US6.2, US6.5.

### regenerateSummary

- **Purpose**: Requests the summary again when a transcript exists but its summary failed or is missing.
- **Callable by**: HOST only.
- **Input**: `bookingUid: string`.
- **Output**: `NotetakerSummaryDto` (the summary record after the request).
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
  - Regeneration is allowed when the summary status is `FAILED`, or when no summary row exists while a transcript does. A status of `PENDING`, `READY` or `NOT_ENOUGH_CONTENT` gives BadRequest.
  - A transcript exists and its results were not deleted, otherwise NotFound.
- **Side effects**: Upserts the summary row to `PENDING`, writes a `NotetakerActivity` record with action `SUMMARY_REQUESTED`, and queues the `notetaker.generate-summary` task with the requesting user's id. The `NotetakerSummaryDto` is returned immediately with status `PENDING`; the `RESULTS_READY` notification is not re-sent.
- **Satisfies**: FR-018, FR-022. Acceptance: US3.4.

### setSharing

- **Purpose**: Shares the transcript and summary with the booking's attendees, or revokes that sharing.
- **Callable by**: HOST only.
- **Input**: `bookingUid: string`, `shared: boolean`.
- **Output**: `{ sharedWithAttendees: boolean }`.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
- **Side effects**:
  - Sharing creates the `NotetakerSharingGrant` row; revoking deletes it, effective immediately.
  - Writes a `NotetakerActivity` record with action `SHARED` or `SHARING_REVOKED`.
  - Sharing sends the `SHARED_WITH_ATTENDEES` notification to attendees, which never contains transcript text.
  - `shared: true` without an existing transcript is BadRequest. `shared: false` always succeeds. A repeat `shared: true` while the grant exists sends no notification.
- **Satisfies**: FR-026, FR-027, FR-031. Acceptance: US6.1, US6.2, US6.5.

### export

- **Purpose**: Produces a Markdown document containing the summary and the speaker-attributed transcript.
- **Callable by**: users with access to the results, that is a HOST or an ATTENDEE with a sharing grant.
- **Input**: `bookingUid: string`, `format: "markdown"`.
- **Output**: `{ filename: string, mimeType: "text/markdown", content: string }`.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller has access, otherwise Forbidden.
  - A transcript exists and its results were not deleted, otherwise NotFound. The export targets the latest session that has a transcript.
- **Side effects**: Writes a `NotetakerActivity` record with action `EXPORTED`.
- **Satisfies**: FR-021, FR-031. Acceptance: US6.3.

### deleteResults

- **Purpose**: Permanently deletes the transcript, its passages and the summary.
- **Callable by**: HOST only.
- **Input**: `bookingUid: string`.
- **Output**: `NotetakerStateDto` showing the results as deleted (`session.resultsDeletedAt` set, `transcript` and `summary` null).
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
  - A transcript exists and its results were not deleted, otherwise NotFound.
- **Side effects**: Hard-deletes every transcript of the booking with its passages and summary, sets `NotetakerSession.resultsDeletedAt` on each affected session, and deletes the sharing grant, removing access for everyone. Writes a `NotetakerActivity` record with action `DELETED`.
- **Satisfies**: FR-028, FR-029, FR-031. Acceptance: US6.4.

### getActivity

- **Purpose**: Lists who enabled, disabled, stopped, shared, exported or deleted, and when.
- **Callable by**: HOST only (the history is visible to hosts, FR-031). A granted ATTENDEE gets Forbidden.
- **Input**: `bookingUid: string`.
- **Output**: `NotetakerActivityDto[]`. The table is append-only and indexed by `(bookingId, createdAt)`; the result is ordered by `createdAt` descending, then `id` descending, and capped at 200 records.
- **Preconditions and errors**:
  - The booking exists, otherwise NotFound.
  - The caller is a HOST, otherwise Forbidden.
- **Side effects**: none.
- **Satisfies**: FR-031. Acceptance: US6.6.

### getEventTypeDefault

- **Purpose**: Reads the event type's notetaker default and whether it can be offered.
- **Callable by**: callers passing `eventOwnerProcedure`: for a team event type a team member with role `ADMIN` or `OWNER`; otherwise the event type's `userId` or a member of its `users`.
- **Input**: `eventTypeId: number`.
- **Output**: `{ enabledByDefault: boolean, available: boolean, unavailableReason: NotetakerIneligibilityReasonDto | null }`. `available` is true when at least one configured location of the event type is a supported type. For event types `unavailableReason` only takes `FEATURE_DISABLED`, `UNSUPPORTED_PLATFORM` or `CAL_VIDEO` (`CAL_VIDEO` when every location is Cal Video).
- **Preconditions and errors**: the event type exists, otherwise NotFound.
- **Side effects**: none.
- **Satisfies**: FR-002, FR-004. Acceptance: US5.5.

### setEventTypeDefault

- **Purpose**: Sets whether new bookings of the event type start with the notetaker on. Existing bookings are not altered, and each booking can override the default.
- **Callable by**: callers passing `eventOwnerProcedure`, as for `getEventTypeDefault`.
- **Input**: `eventTypeId: number`, `enabledByDefault: boolean`.
- **Output**: the same shape as `getEventTypeDefault`, after the change.
- **Preconditions and errors**:
  - The event type exists, otherwise NotFound.
  - Setting `enabledByDefault` to true requires `available` to be true (at least one supported location), otherwise BadRequest. Setting it to false is always allowed.
- **Side effects**: Upserts `EventTypeNotetakerSettings`. No `NotetakerActivity` record is written (the table is keyed by booking, and FR-031 covers booking-level actions); the only trace is `EventTypeNotetakerSettings.updatedAt`. A booking that later inherits the default records `ENABLED` with `actorType = SYSTEM` and `detail.source = "EVENT_TYPE_DEFAULT"`.
- **Satisfies**: FR-004, FR-014. Acceptance: US5.1, US5.4, US5.5.

## Public procedure

### publicViewer.notetakerDisclosure

- **Kind**: query, unauthenticated.
- **Input**: `{ eventTypeId: number }`.
- **Output**: `{ enabledByDefault: boolean, onBehalfOf: string | null, supportedLocationTypes: string[] }`.
- **Purpose**: Lets the public booking page (Booker) show, before the booker confirms, "This meeting will be transcribed by an automated notetaker on behalf of {host}". The Booker shows the notice when `enabledByDefault` is true and the selected location is one of `supportedLocationTypes`.
- **Data exposure**: returns no booking or transcript data.
- **Satisfies**: FR-014. Acceptance: User Story 5 (US5.2).

## DTOs

DTOs live in `packages/lib/dto/`. Prisma types never cross this boundary. Enum DTOs are string-literal unions whose values equal the design's enum values.

```ts
export type NotetakerSessionStatusDto =
  | "SCHEDULED"
  | "WAITING_TO_BE_ADMITTED"
  | "TRANSCRIBING"
  | "PROCESSING"
  | "READY"
  | "ENDED_EARLY"
  | "FAILED";

export type NotetakerOutcomeReasonDto =
  | "NOT_ADMITTED"
  | "MEETING_DID_NOT_START"
  | "NO_SPEECH_DETECTED"
  | "REMOVED_BY_PARTICIPANT"
  | "STOPPED_BY_HOST"
  | "INTERRUPTED"
  | "LENGTH_LIMIT_REACHED"
  | "MEETING_LINK_UNUSABLE";

export type NotetakerPlatformDto = "GOOGLE_MEET" | "MICROSOFT_TEAMS";

export type NotetakerChoiceSourceDto = "HOST" | "EVENT_TYPE_DEFAULT";

export type NotetakerTranscriptCompletenessDto = "COMPLETE" | "PARTIAL" | "TRUNCATED";

export type NotetakerSummaryStatusDto = "PENDING" | "READY" | "FAILED" | "NOT_ENOUGH_CONTENT";

export type NotetakerActivityActionDto =
  | "ENABLED"
  | "DISABLED"
  | "STOPPED"
  | "SHARED"
  | "SHARING_REVOKED"
  | "EXPORTED"
  | "DELETED"
  | "SUMMARY_REQUESTED";

export type NotetakerActorTypeDto = "USER" | "PARTICIPANT" | "SYSTEM";

export type NotetakerIneligibilityReasonDto =
  | "FEATURE_DISABLED"
  | "UNSUPPORTED_PLATFORM"
  | "CAL_VIDEO"
  | "IN_PERSON_OR_PHONE"
  | "NO_MEETING_LINK"
  | "BOOKING_NOT_ACTIVE"
  | "MEETING_ENDED"
  | "REJOIN_BLOCKED";

export type NotetakerStateDto = {
  bookingUid: string;
  featureEnabled: boolean;
  viewerRole: "HOST" | "ATTENDEE";
  eligibility: {
    eligible: boolean;
    platform: NotetakerPlatformDto | null;
    reason: NotetakerIneligibilityReasonDto | null;
  };
  choice: {
    enabled: boolean;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByName: string | null;
    setAt: string;
  } | null;
  status: NotetakerSessionStatusDto | null;
  canToggle: boolean;
  canStop: boolean;
  isRecurring: boolean;
  session: {
    id: string;
    status: NotetakerSessionStatusDto;
    outcomeReason: NotetakerOutcomeReasonDto | null;
    startedLate: boolean;
    joinRequestedAt: string | null;
    admittedAt: string | null;
    endedAt: string | null;
    interruptedAtMs: number | null;
    resultsDeletedAt: string | null;
  } | null;
  transcript: {
    id: string;
    language: string | null;
    completeness: NotetakerTranscriptCompletenessDto;
    durationMs: number;
    passageCount: number;
  } | null;
  summary: NotetakerSummaryDto | null;
  sharedWithAttendees: boolean;
};

export type NotetakerPassageDto = {
  index: number;
  speakerName: string | null;
  unknownSpeakerNumber: number | null;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
};

export type NotetakerSummaryDto = {
  status: NotetakerSummaryStatusDto;
  language: string | null;
  overview: string | null;
  keyPoints: string[];
  decisions: string[];
  actionItems: { text: string; owner: string | null }[];
  generatedAt: string | null;
};

export type NotetakerActivityDto = {
  id: string;
  action: NotetakerActivityActionDto;
  actorType: NotetakerActorTypeDto;
  actorName: string | null;
  createdAt: string;
  detail: Record<string, unknown> | null;
};
```

`NotetakerPassageDto` carries exactly one of `speakerName` and `unknownSpeakerNumber` as non-null. `NotetakerSummaryDto` is returned as `NotetakerStateDto.summary` and by `regenerateSummary`.

## Errors

Raised in services as `ErrorWithCode` through `ErrorWithCode.Factory` and converted to tRPC errors by the tRPC layer.

| Condition | Error kind | When it occurs |
|---|---|---|
| Caller is not a host of the booking | Forbidden | Any host-only procedure (`setEnabled`, `stop`, `regenerateSummary`, `setSharing`, `deleteResults`, `getActivity`) called by an attendee, including a granted one, or any other user |
| Caller cannot manage the event type | Forbidden | `getEventTypeDefault` or `setEventTypeDefault` called by someone who fails `eventOwnerProcedure` |
| Attendee without a sharing grant | Forbidden | `getState`, `listPassages`, `export` called by a matching attendee while no `NotetakerSharingGrant` exists, including after revocation |
| Caller unrelated to the booking | Forbidden | Any booking procedure called by a user who is neither a host nor an attendee |
| Booking, session or event type not found | NotFound | The `bookingUid` or `eventTypeId` does not resolve |
| No transcript or results deleted | NotFound | `regenerateSummary`, `listPassages`, `export` or `deleteResults` when the booking has no transcript, or its results were deleted |
| Nothing to stop | BadRequest | `stop` with no session in `SCHEDULED`, `WAITING_TO_BE_ADMITTED` or `TRANSCRIBING` |
| Sharing without a transcript | BadRequest | `setSharing` with `shared: true` when no transcript exists |
| Event type unavailable | BadRequest | `setEventTypeDefault` with `enabledByDefault: true` when `available` is false |
| Booking ineligible | BadRequest | Enabling on a booking that is not eligible (feature disabled, unsupported platform, Cal Video, in person or phone, no meeting link, booking not active) |
| Meeting ended | BadRequest | Enabling after `booking.endTime` (`MEETING_ENDED`) |
| Rejoin blocked | BadRequest | Enabling after a participant removed the notetaker or a host stopped it after admission (`REJOIN_BLOCKED`) |
| Summary not regenerable | BadRequest | `regenerateSummary` when the summary status is `PENDING`, `READY` or `NOT_ENOUGH_CONTENT` (allowed for `FAILED`, or when no summary row exists while a transcript does) |

## Compatibility

This router is new and additive. No existing tRPC procedure, API v2 endpoint, webhook trigger or booking payload changes shape.
