import type {
  INotetakerCalendarGuestGateway,
  NotetakerCalendarEventRef,
  NotetakerCalendarGuestOutcome,
} from "./INotetakerCalendarGuestGateway";

type NotetakerGoogleEventAttendee = { email?: string | null };
type NotetakerGoogleEvent = {
  status?: string | null;
  hangoutLink?: string | null;
  attendeesOmitted?: boolean | null;
  attendees?: NotetakerGoogleEventAttendee[] | null;
};

export interface INotetakerGoogleEventsClient {
  events: {
    get(params: { calendarId: string; eventId: string }): Promise<{ data: NotetakerGoogleEvent }>;
    patch(params: {
      calendarId: string;
      eventId: string;
      sendUpdates: "none";
      requestBody: { attendees: NotetakerGoogleEventAttendee[] };
    }): Promise<unknown>;
  };
}

export interface IGoogleCalendarGuestGatewayDeps {
  /** null when the credential is missing, invalid or not a Google Calendar credential */
  getEventsClient: (credentialId: number) => Promise<INotetakerGoogleEventsClient | null>;
}

export class GoogleCalendarGuestGateway implements INotetakerCalendarGuestGateway {
  constructor(private readonly deps: IGoogleCalendarGuestGatewayDeps) {}

  async ensureGuest(params: {
    event: NotetakerCalendarEventRef;
    guestEmail: string;
    meetingUrl: string;
  }): Promise<NotetakerCalendarGuestOutcome> {
    const { event, guestEmail, meetingUrl } = params;

    const client = await this.deps.getEventsClient(event.credentialId);
    if (!client) return "CREDENTIAL_UNAVAILABLE";

    const calendarId = event.calendarId ?? "primary";
    const { data } = await client.events.get({ calendarId, eventId: event.eventId });

    if (data.status === "cancelled") return "NOT_THE_MEETING_EVENT";
    if (!data.hangoutLink) return "NOT_THE_MEETING_EVENT";
    if (!isSameMeetingLink(data.hangoutLink, meetingUrl)) return "NOT_THE_MEETING_EVENT";
    // A partial guest list cannot be written back without dropping the guests that were left out.
    if (data.attendeesOmitted === true) return "NOT_THE_MEETING_EVENT";

    const existing = data.attendees ?? [];
    const wanted = guestEmail.toLowerCase();
    if (existing.some((attendee) => attendee.email?.trim().toLowerCase() === wanted)) {
      return "ALREADY_PRESENT";
    }

    // A patch replaces the whole guest list, so the existing guests go back exactly as received: they carry
    // response status, organizer flag and other fields this type does not name.
    await client.events.patch({
      calendarId,
      eventId: event.eventId,
      sendUpdates: "none",
      requestBody: { attendees: [...existing, { email: guestEmail }] },
    });
    return "ADDED";
  }
}

export function isSameMeetingLink(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const first = new URL(a);
  const second = new URL(b);
  const isWebUrl = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";
  if (!isWebUrl(first) || !isWebUrl(second)) return false;

  const normalizedPath = (url: URL): string => url.pathname.toLowerCase().replace(/\/+$/, "");
  return (
    first.host.toLowerCase() === second.host.toLowerCase() && normalizedPath(first) === normalizedPath(second)
  );
}
