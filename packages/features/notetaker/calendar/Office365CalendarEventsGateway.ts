import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerCalendarEvent } from "../lib/calendarMeeting";
import { extractMeetingLinksFromText } from "../lib/calendarMeeting";
import type {
  INotetakerCalendarEventsGateway,
  NotetakerAutoJoinCalendarRecord,
} from "./INotetakerCalendarEventsGateway";

type NotetakerOffice365EventTime = { dateTime?: string | null; timeZone?: string | null };
type NotetakerOffice365EmailAddress = { emailAddress?: { address?: string | null } | null };
type NotetakerOffice365ListedEvent = {
  id?: string | null;
  iCalUId?: string | null;
  subject?: string | null;
  start?: NotetakerOffice365EventTime | null;
  end?: NotetakerOffice365EventTime | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  isOrganizer?: boolean | null;
  responseStatus?: { response?: string | null } | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string | null; locationUri?: string | null } | null;
  attendees?: NotetakerOffice365EmailAddress[] | null;
  organizer?: NotetakerOffice365EmailAddress | null;
  bodyPreview?: string | null;
  body?: { content?: string | null } | null;
  seriesMasterId?: string | null;
};

const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

// The reader asks Graph for UTC, which comes back as a wall-clock dateTime without an offset.
function parseEventTime(time: NotetakerOffice365EventTime | null | undefined): Date | null {
  const value = time?.dateTime;
  if (!value) return null;
  const parsed = new Date(HAS_UTC_OFFSET.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toSelfResponse(item: NotetakerOffice365ListedEvent): NotetakerCalendarEvent["selfResponse"] {
  const response = item.responseStatus?.response;
  if (response === "declined") return "declined";
  if (item.isOrganizer === true || response === "organizer") return "organizer";
  if (response === "accepted") return "accepted";
  if (response === "tentativelyAccepted") return "tentative";
  if (response === "notResponded" || response === "none") return "needsAction";
  return null;
}

function toEmail(address: NotetakerOffice365EmailAddress | null | undefined): string | null {
  return address?.emailAddress?.address?.trim().toLowerCase() || null;
}

function toCandidateLinks(item: NotetakerOffice365ListedEvent): string[] {
  const links: string[] = [];
  if (item.onlineMeeting?.joinUrl) links.push(item.onlineMeeting.joinUrl);
  if (item.onlineMeetingUrl) links.push(item.onlineMeetingUrl);
  if (item.location?.displayName) links.push(...extractMeetingLinksFromText(item.location.displayName));
  if (item.location?.locationUri) links.push(...extractMeetingLinksFromText(item.location.locationUri));
  const bodyText = item.body?.content || item.bodyPreview;
  if (bodyText) links.push(...extractMeetingLinksFromText(bodyText));
  return Array.from(new Set(links));
}

function toNotetakerCalendarEvent(item: NotetakerOffice365ListedEvent): NotetakerCalendarEvent | null {
  if (!item.id) return null;
  const start = parseEventTime(item.start);
  if (!start) return null;
  const end = parseEventTime(item.end) ?? start;

  const attendeeEmails: string[] = [];
  for (const attendee of item.attendees ?? []) {
    const email = toEmail(attendee);
    if (email) attendeeEmails.push(email);
  }

  return {
    externalId: item.id,
    iCalUID: item.iCalUId ?? null,
    recurringEventId: item.seriesMasterId ?? null,
    title: item.subject ?? null,
    start,
    end,
    isAllDay: item.isAllDay === true,
    status: item.isCancelled === true ? "cancelled" : "confirmed",
    selfResponse: toSelfResponse(item),
    organizerEmail: toEmail(item.organizer),
    attendeeEmails,
    candidateLinks: toCandidateLinks(item),
  };
}

export interface INotetakerOffice365EventsReader {
  /** Paginates internally; rejects on a Graph error. */
  listEventsWithMeetingDetails(p: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }): Promise<NotetakerOffice365ListedEvent[]>;
}

export interface IOffice365CalendarEventsGatewayDeps {
  /** null when the calendar's credential is missing, invalid or not an Office 365 Calendar credential */
  getEventsReader: (
    calendar: NotetakerAutoJoinCalendarRecord
  ) => Promise<INotetakerOffice365EventsReader | null>;
}

export class Office365CalendarEventsGateway implements INotetakerCalendarEventsGateway {
  constructor(private readonly deps: IOffice365CalendarEventsGatewayDeps) {}

  async listEvents(p: {
    calendar: NotetakerAutoJoinCalendarRecord;
    timeMin: Date;
    timeMax: Date;
  }): Promise<NotetakerCalendarEvent[]> {
    const { calendar, timeMin, timeMax } = p;

    const reader = await this.deps.getEventsReader(calendar);
    if (!reader) {
      throw ErrorWithCode.Factory.NotFound(
        `Office 365 Calendar credential for selected calendar ${calendar.selectedCalendarId} is missing, invalid or not an Office 365 Calendar credential`
      );
    }

    const items = await reader.listEventsWithMeetingDetails({
      calendarId: calendar.externalId,
      timeMin,
      timeMax,
    });

    const events: NotetakerCalendarEvent[] = [];
    for (const item of items) {
      const event = toNotetakerCalendarEvent(item);
      if (event) events.push(event);
    }
    return events;
  }
}
