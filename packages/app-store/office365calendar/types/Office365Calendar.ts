export type O365AuthCredentials = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export type Office365CalendarViewDateTime = { dateTime?: string | null; timeZone?: string | null };
export type Office365CalendarViewEmailAddress = { emailAddress?: { address?: string | null } | null };

export type Office365CalendarViewEvent = {
  id?: string | null;
  iCalUId?: string | null;
  subject?: string | null;
  start?: Office365CalendarViewDateTime | null;
  end?: Office365CalendarViewDateTime | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  isOrganizer?: boolean | null;
  responseStatus?: { response?: string | null } | null;
  isOnlineMeeting?: boolean | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string | null; locationUri?: string | null } | null;
  attendees?: Office365CalendarViewEmailAddress[] | null;
  organizer?: Office365CalendarViewEmailAddress | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  seriesMasterId?: string | null;
};

export interface Office365CalendarEventsReader {
  /** Times in the returned events are UTC wall-clock values without an offset. */
  listEventsWithMeetingDetails(p: {
    calendarId: string;
    timeMin: Date;
    timeMax: Date;
  }): Promise<Office365CalendarViewEvent[]>;
}
