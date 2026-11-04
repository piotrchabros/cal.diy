// UNVERIFIED AGAINST THE REAL SERVICE: written from the Graph calendarView docs and only type-checked; it was
// not run against a real Microsoft credential.
import { getCredentialForSelectedCalendar } from "@calcom/app-store/delegationCredential";
import { createOffice365CalendarServiceWithEventsReader } from "@calcom/app-store/office365calendar/lib/CalendarService";
import type { NotetakerAutoJoinCalendarRecord } from "./INotetakerCalendarEventsGateway";
import type { INotetakerOffice365EventsReader } from "./Office365CalendarEventsGateway";

// getCredentialForSelectedCalendar resolves only credentialId, so a calendar reached solely through a
// delegation credential has no reader here and its listing fails until delegation is supported.
export async function getNotetakerOffice365EventsReader(
  calendar: Pick<NotetakerAutoJoinCalendarRecord, "credentialId" | "delegationCredentialId">
): Promise<INotetakerOffice365EventsReader | null> {
  const credential = await getCredentialForSelectedCalendar({
    credentialId: calendar.credentialId,
    delegationCredentialId: calendar.delegationCredentialId,
  });
  if (!credential || credential.type !== "office365_calendar" || credential.invalid) return null;
  return createOffice365CalendarServiceWithEventsReader(credential);
}
