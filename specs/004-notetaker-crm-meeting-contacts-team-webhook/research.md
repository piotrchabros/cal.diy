# Research: Meeting Contacts and the Team Webhook for the CRM

**Date**: 2026-11-06 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Findings come from reading cal.diy code (notetaker slice, `packages/features/webhooks`, `packages/features/bookings`, the webhook tRPC router) and the user decisions recorded in the phase 2 plan.

## Facts

- Ad-hoc bookings (`PrismaBookingNotetakerRepository.createAdHocBooking`) and calendar auto-join bookings have no attendees, no event type, and metadata markers (`notetakerAdHoc`, `notetakerSharingTeamId`, `notetakerCalendarMeeting`). No edit path for an ad-hoc meeting existed.
- `Attendee` rows drive: the attendee notice email for ad-hoc meetings (`enqueueAttendeeNotice`), shared-results emails, `ATTENDEE` access to transcripts, visibility of the booking under `/bookings` for that email, and `addGuests`.
- `Webhook.teamId` exists; `createWebhookProcedure` checked ownership by `userId` or event type only, never the team role; `create.handler` connected the creating user even for team webhooks; every booking flow passed `teamId: null` to `getWebhooks` for personal bookings; MEETING_* rows are created per subscriber by `scheduleTrigger`; `fetchBookingsFromWebhook` backfilled team event-type bookings only.
- `WebhookRepository.PermissionCheckService` is a local stub (`checkPermission`/`hasPermission` return true, `getTeamIdsWithPermission` returns `[]`); team webhook visibility in `getByViewer` therefore depends on membership alone.
- `NotetakerAccessService.isSharedViewer` grants colleagues read access when: the booking has a team, mode is not `HOSTS_ONLY`, the latest session with a transcript has `colleagueSharingDisclosed` and no `resultsDeletedAt`, and `resolveNotetakerSharingScope` resolves (for a personal event type: the owner is an accepted member of the chosen team).
- Google's events list field mask did not request `displayName`; Office 365 attendees carry `emailAddress.name`.

## Decision 1: Contacts are a separate table, not `Attendee` rows

- **Decision**: `NotetakerMeetingContact { bookingId, email, name?, source MANUAL|CALENDAR }`, unique per booking and email, cascade with the booking, read only by the transcript webhook gateway and the host's booking page.
- **Rationale**: an `Attendee` row would email the contact (ad-hoc notice, shared results), give them `ATTENDEE` access to the transcript, show the booking in their bookings list and feed `addGuests`. The CRM needs the email, not a participant.
- **Alternatives**: `Attendee` rows with a flag (rejected: every consumer would need the flag); storing emails in booking metadata (rejected: no names, no uniqueness, harder to query, metadata already carries markers).

## Decision 2: Manual contacts replace, calendar contacts are refreshed by the owner only

- **Decision**: `replaceForSource` replaces one source's rows and leaves the other's. Manual sets come from the dispatch input or the `setMeetingContacts` mutation (host only, ad-hoc or calendar meetings only). Calendar sets are rewritten on every sweep of the owner's calendar while the meeting has not ended; other participants' calendars never write.
- **Rationale**: two participants of one calendar meeting may see different invite lists; the owner's is the reference. After the meeting ends the list is frozen so a late calendar change cannot alter what was already sent.
- **Alternatives**: merge across all participants (rejected: contacts would differ per sweep order); never refresh (rejected: invitees added before the meeting would be missed).

## Decision 3: Exclusions and caps

- **Decision**: drop the owner's email and verified emails, other cal.diy participants' primary and verified emails, the organizer when the owner is the organizer, calendar resources (`@resource.calendar.google.com`, `room-*@*.onmicrosoft.com`), invalid addresses and duplicates; keep at most 20 manual and 50 calendar contacts; keep the external organizer as a contact.
- **Rationale**: the CRM wants customers, not staff or rooms; the CRM additionally drops attendees that are CRM users (companion spec). Caps bound the payload and the form.

## Decision 4: One flag on `Webhook`, team-owned when set

- **Decision**: `includeMemberMeetings Boolean @default(false)`; allowed only for a non-organization team webhook without platform or event-type scope; set or edited only by a team admin/owner (`MembershipRepository.getAdminOrOwnerMembership`); a flagged webhook is stored with `userId` null and stays so even when the flag is removed; its team and event type cannot change; ownerless team webhooks are readable, editable, testable and deletable by that team's admins/owners only and hidden from plain members in lists.
- **Rationale**: user decision 3: nothing changes for existing team webhooks, so the stricter rules hang on the flag and on the ownerless state the flag creates. An ownerless webhook keeps firing when the admin who created it leaves; it must therefore not be governed by a `userId` match. Keeping `userId` null after unflagging avoids silently handing an admin a personal webhook with the team's secret.
- **Alternatives**: a separate `TeamWebhookSubscription` table (rejected: duplicates delivery code); reusing `teamId` alone (rejected: would widen every team webhook, violating decision 1 of the user); organization-level flag (deferred: an org's "members" span many teams and sharing is per team).

## Decision 5: Matching rule = the notetaker sharing scope, resolved at event time

- **Decision**: a flagged webhook of team T receives a booking's events iff `resolveMemberSharingTeamIds` returns `[T]`: the sharing team derived as `deriveNotetakerSharingTeam` does (team event type → its team; personal event type → `EventTypeNotetakerSettings.sharingTeam`; no event type → `metadata.notetakerSharingTeamId`), the mode is `TEAM`, `resolveNotetakerSharingScope` resolves, and the booking owner is an accepted member of T (checked explicitly when the source has no sharing owner, which is the team event type case). `HOSTS_ONLY` and `SELECTED_PEOPLE` never match. For transcripts the session additionally must be disclosed and not deleted (`isTranscriptSharedWithTeam`), mirroring `isSharedViewer`.
- **Rationale**: user decision 1. The rule a colleague is granted read access by already encodes "this team may see this meeting"; reusing it keeps one definition of sharing.
- **Alternatives**: all bookings of all accepted members (rejected: leaks hosts-only meetings); a per-booking opt-in flag (rejected: a second concept for the same question).

## Decision 6: Pure helper plus one `getWebhooks` option

- **Decision**: `packages/features/notetaker/lib/webhookSharingTeam.ts` is pure (takes a `Pick<INotetakerMembershipLookup, "isAcceptedMember">`); `getWebhooks`/`GetSubscribersOptions` gain `memberSharingTeamIds?: number[]`, translated to `OR { teamId in ids, includeMemberMeetings: true }` and a seventh `UNION ALL` branch in the raw query. Senders keep passing `teamId: null` for personal bookings and add the new option.
- **Rationale**: the helper has no Prisma so every sender and the scheduler can call it with their own membership source (`RegularBookingService` wraps `MembershipRepository`; `fetchMemberSharingBookings` uses the memberships it already loaded). Adding an option instead of changing `teamId` keeps existing subscriber queries byte-identical.

## Decision 7: Which senders pass the option

- **Decision**: BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_REQUESTED, BOOKING_CANCELLED (cancel and request-reschedule), BOOKING_REJECTED, MEETING_STARTED, MEETING_ENDED and RECORDING_TRANSCRIPTION_GENERATED. Not BOOKING_PAYMENT_INITIATED / BOOKING_PAID (`BookingWebhookService` path), not no-show, OOO or form triggers. Seated bookings are covered: `handleSeats` calls `handleWebhookTrigger` with the `subscriberOptions` built in `RegularBookingService`, which carry `memberSharingTeamIds`.
- **Rationale**: the CRM tracks the meeting lifecycle and the transcript; payment events are not CRM concerns in this phase and live in a different webhook service that would need its own plumbing. Documented as a known gap.

## Decision 8: Backfill and reconciliation of scheduled rows

- **Decision**: `fetchBookingsFromWebhook` concatenates `fetchMemberSharingBookings` for flagged webhooks, so creating a flagged webhook, activating it, or adding a MEETING_* trigger schedules rows for the members' future shared bookings; toggling the flag on an active webhook runs `reconcileMemberMeetingTriggers`, which schedules or deletes rows for triggers kept selected. Rows are not removed later when a member leaves or sharing is turned off (known gap).
- **Rationale**: matches how team event-type bookings are backfilled today. Removal on membership or sharing changes would touch two more modules; transcripts are safe regardless because their scope is resolved at send time.

## Decision 9: Admin check in the UI is advisory, the server decides

- **Decision**: the new and edit webhook pages look up the caller's role and pass `canManageMemberMeetings`; the form disables the switch and shows a note; the views omit the flag from the mutation when not applicable. The handlers enforce the rule regardless.
- **Rationale**: the form is reused for user, event-type and platform webhooks; showing the switch only with a team id keeps those untouched.

## Decision 10: `delete` returns NOT_FOUND instead of silently succeeding

- **Decision**: when neither the owner lookup nor the ownerless-team lookup finds the webhook, throw `NOT_FOUND`.
- **Rationale**: the previous silent success hid the ownerless case; the client already handles errors. Small behaviour change, documented.
