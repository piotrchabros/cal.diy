import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerCalendarEvent } from "../lib/calendarMeeting";
import { extractMeetingLinksFromText } from "../lib/calendarMeeting";
import type {
  INotetakerCalendarEventsGateway,
  NotetakerAutoJoinCalendarRecord,
} from "./INotetakerCalendarEventsGateway";

type NotetakerGoogleEventTime = { date?: string | null; dateTime?: string | null };
type NotetakerGoogleListedAttendee = {
  email?: string | null;
  self?: boolean | null;
  responseStatus?: string | null;
  organizer?: boolean | null;
};
type NotetakerGoogleListedEvent = {
  id?: string | null;
  iCalUID?: string | null;
  status?: string | null;
  summary?: string | null;
  start?: NotetakerGoogleEventTime | null;
  end?: NotetakerGoogleEventTime | null;
  originalStartTime?: NotetakerGoogleEventTime | null;
  hangoutLink?: string | null;
  conferenceData?: { entryPoints?: { entryPointType?: string | null; uri?: string | null }[] | null } | null;
  location?: string | null;
  description?: string | null;
  attendees?: NotetakerGoogleListedAttendee[] | null;
  organizer?: { email?: string | null; self?: boolean | null } | null;
  recurringEventId?: string | null;
};

const PAGE_SIZE = 250;
// A 24h lookahead never comes close to 2500 events; the cap only guards against a runaway page loop.
const MAX_PAGES = 10;
// originalStartTime is the only time Google keeps on some cancelled instances of a recurring event.
const LIST_FIELDS =
  "nextPageToken,items(id,iCalUID,status,summary,start,end,originalStartTime,hangoutLink," +
  "conferenceData/entryPoints,location,description," +
  "attendees(email,self,responseStatus,organizer),organizer(email,self),recurringEventId)";

const ATTENDEE_RESPONSES = ["accepted", "tentative", "needsAction", "declined"] as const;
type NotetakerAttendeeResponse = (typeof ATTENDEE_RESPONSES)[number];

function parseEventTime(time: NotetakerGoogleEventTime | null | undefined): Date | null {
  const value = time?.dateTime ?? time?.date;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toStatus(status: string | null | undefined): NotetakerCalendarEvent["status"] {
  if (status === "cancelled" || status === "tentative") return status;
  return "confirmed";
}

function toAttendeeResponse(status: string | null | undefined): NotetakerAttendeeResponse | null {
  return ATTENDEE_RESPONSES.find((response) => response === status) ?? null;
}

function toSelfResponse(item: NotetakerGoogleListedEvent): NotetakerCalendarEvent["selfResponse"] {
  const selfAttendee = item.attendees?.find((attendee) => attendee.self === true);
  const selfAttendeeResponse = toAttendeeResponse(selfAttendee?.responseStatus);
  const isOrganizer = item.organizer?.self === true || selfAttendee?.organizer === true;
  // An organizer who declined their own event does not want a bot there either.
  if (isOrganizer) return selfAttendeeResponse === "declined" ? "declined" : "organizer";
  return selfAttendeeResponse;
}

function toCandidateLinks(item: NotetakerGoogleListedEvent): string[] {
  const links: string[] = [];
  if (item.hangoutLink) links.push(item.hangoutLink);
  for (const entryPoint of item.conferenceData?.entryPoints ?? []) {
    if (entryPoint.entryPointType === "video" && entryPoint.uri) links.push(entryPoint.uri);
  }
  if (item.location) links.push(...extractMeetingLinksFromText(item.location));
  if (item.description) links.push(...extractMeetingLinksFromText(item.description));
  return Array.from(new Set(links));
}

function toNotetakerCalendarEvent(item: NotetakerGoogleListedEvent): NotetakerCalendarEvent | null {
  if (!item.id) return null;
  const start = parseEventTime(item.start) ?? parseEventTime(item.originalStartTime);
  if (!start) return null;
  const end = parseEventTime(item.end) ?? start;

  const attendeeEmails: string[] = [];
  for (const attendee of item.attendees ?? []) {
    const email = attendee.email?.trim().toLowerCase();
    if (email) attendeeEmails.push(email);
  }

  return {
    externalId: item.id,
    iCalUID: item.iCalUID ?? null,
    recurringEventId: item.recurringEventId ?? null,
    title: item.summary ?? null,
    start,
    end,
    isAllDay: Boolean(item.start?.date) || (!item.start && Boolean(item.originalStartTime?.date)),
    status: toStatus(item.status),
    selfResponse: toSelfResponse(item),
    organizerEmail: item.organizer?.email?.trim().toLowerCase() || null,
    attendeeEmails,
    candidateLinks: toCandidateLinks(item),
  };
}

export type NotetakerGoogleEventsListParams = {
  calendarId: string;
  singleEvents: true;
  orderBy: "startTime";
  showDeleted: true;
  timeMin: string;
  timeMax: string;
  maxResults: number;
  pageToken?: string;
  fields: string;
};

export interface INotetakerGoogleEventsListClient {
  events: {
    list(params: NotetakerGoogleEventsListParams): Promise<{
      data: { nextPageToken?: string | null; items?: NotetakerGoogleListedEvent[] | null };
    }>;
  };
}

export interface IGoogleCalendarEventsGatewayDeps {
  /** null when the calendar's credential is missing, invalid or not a Google Calendar credential */
  getEventsClient: (
    calendar: NotetakerAutoJoinCalendarRecord
  ) => Promise<INotetakerGoogleEventsListClient | null>;
}

export class GoogleCalendarEventsGateway implements INotetakerCalendarEventsGateway {
  constructor(private readonly deps: IGoogleCalendarEventsGatewayDeps) {}

  async listEvents(p: {
    calendar: NotetakerAutoJoinCalendarRecord;
    timeMin: Date;
    timeMax: Date;
  }): Promise<NotetakerCalendarEvent[]> {
    const { calendar, timeMin, timeMax } = p;

    const client = await this.deps.getEventsClient(calendar);
    if (!client) {
      throw ErrorWithCode.Factory.NotFound(
        `Google Calendar credential for selected calendar ${calendar.selectedCalendarId} is missing, invalid or not a Google Calendar credential`
      );
    }

    const events: NotetakerCalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await client.events.list({
        calendarId: calendar.externalId,
        // Cancelled instances must come back so the caller can tell a cancelled occurrence from a missing one.
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: true,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: PAGE_SIZE,
        fields: LIST_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      });

      for (const item of data.items ?? []) {
        const event = toNotetakerCalendarEvent(item);
        if (event) events.push(event);
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return events;
  }
}
