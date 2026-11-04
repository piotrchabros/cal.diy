// UNVERIFIED AGAINST THE REAL SERVICE: see specs/001-meeting-transcription/tasks.md T219
// Written from the typings and only type-checked; it was not run against a real Google credential.
// Remove this notice once T219 records a real check.
import { getCredentialForSelectedCalendar } from "@calcom/app-store/delegationCredential";
import { createGoogleCalendarServiceWithGoogleType } from "@calcom/app-store/googlecalendar/lib/CalendarService";
import { CredentialRepository } from "@calcom/features/credentials/repositories/CredentialRepository";
import type { INotetakerGoogleEventsListClient } from "./GoogleCalendarEventsGateway";
import type { INotetakerGoogleEventsClient } from "./GoogleCalendarGuestGateway";
import type { NotetakerAutoJoinCalendarRecord } from "./INotetakerCalendarEventsGateway";

export async function getNotetakerGoogleEventsClient(
  credentialId: number
): Promise<INotetakerGoogleEventsClient | null> {
  const credential = await CredentialRepository.findCredentialForCalendarServiceById({ id: credentialId });
  if (!credential || credential.type !== "google_calendar" || credential.invalid) return null;
  return createGoogleCalendarServiceWithGoogleType(credential).authedCalendar();
}

// getCredentialForSelectedCalendar resolves only credentialId, so a calendar reached solely through a
// delegation credential has no client here and its listing fails until delegation is supported.
export async function getNotetakerGoogleEventsListClient(
  calendar: Pick<NotetakerAutoJoinCalendarRecord, "credentialId" | "delegationCredentialId">
): Promise<INotetakerGoogleEventsListClient | null> {
  const credential = await getCredentialForSelectedCalendar({
    credentialId: calendar.credentialId,
    delegationCredentialId: calendar.delegationCredentialId,
  });
  if (!credential || credential.type !== "google_calendar" || credential.invalid) return null;
  const calendarClient = await createGoogleCalendarServiceWithGoogleType(credential).authedCalendar();
  // googleapis overloads events.list with a two-argument streaming form first, so the client is not
  // structurally assignable to the one-argument interface and needs this adapter.
  return {
    events: {
      list: async (params) => {
        const { data } = await calendarClient.events.list(params);
        return { data };
      },
    },
  };
}
