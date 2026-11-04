# Contract: tRPC `viewer.notetaker`, meeting contacts

Extends `specs/001-meeting-transcription/contracts/trpc-notetaker.md` and `specs/002-speaker-names-team-sharing/contracts/trpc-notetaker-sharing.md`. Existing procedures keep their inputs; outputs only gain fields. Service errors are `ErrorWithCode` and reach the client through the existing conversion.

## Shared input schema

`ZNotetakerContactEmailsSchema` (`setMeetingContacts.schema.ts`): `z.array(z.string().trim().toLowerCase().email().max(320)).max(20)`.

## Changed input

### `dispatchToMeeting`

Gains optional `contactEmails: ZNotetakerContactEmailsSchema`. After the ad-hoc booking is created the emails are normalized (owner's verified emails dropped, duplicates collapsed, resources dropped, at most 20) and stored as `MANUAL` contacts. The response is unchanged (`{ bookingUid, reused }`). When the meeting is reused (`reused: true`) the emails are ignored.

## New mutation

### `setMeetingContacts({ bookingUid, emails })`

- Input: `bookingUid: string` (min 1), `emails: ZNotetakerContactEmailsSchema`.
- Rate limit: `core`, identifier `notetaker.setMeetingContacts:<userId>`.
- Authorization: the caller must be a host of the booking (`NotetakerAccessService.assertHost`); otherwise Forbidden.
- Precondition: the booking's metadata marks it as ad-hoc or as a calendar meeting; otherwise `ErrorWithCode` `MEETING_CONTACTS_NOT_SUPPORTED` (UI key `notetaker_contact_emails_not_supported`).
- Effect: replaces the booking's `MANUAL` contacts with the normalized emails (names null); `CALENDAR` contacts are untouched; an email already stored as `CALENDAR` is skipped.
- Output: `{ meetingContacts: { email, name | null, source: "MANUAL" | "CALENDAR" }[] }`, the full list ordered by creation then email.
- No email is sent, no activity is recorded, and nothing is re-sent to the CRM if the transcript was already dispatched.

## Changed output

### `getState({ bookingUid })`

For `viewerRole` `HOST` only:

```text
meetingContacts?: { email: string, name: string | null, source: "MANUAL" | "CALENDAR" }[]
transcriptWebhookSent?: boolean   // the latest transcript was already claimed for the webhook
```

Both are absent for attendees and shared viewers. The UI shows the contacts editor when `isAdHoc || isCalendarMeeting`, and the already-sent note when `transcriptWebhookSent`.

## Client-side validation (`apps/web/modules/notetaker/lib/contactEmailInput.ts`)

`validateContactEmailInput(text)` splits on commas, semicolons and whitespace, returns `{ emails, error: "INVALID" | "TOO_MANY" | null }`; the error keys are `notetaker_contact_emails_invalid` and `notetaker_contact_emails_too_many`.

## i18n keys (`packages/i18n/locales/en/common.json`)

`notetaker_contact_emails_label`, `_hint`, `_invalid`, `_too_many`, `_saved`, `_already_sent`, `_from_calendar`, `_not_supported`.
