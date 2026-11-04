import type { NotetakerPlatformDto } from "./NotetakerStateDto";

export type ExternalCalendarEventCalendarDto = {
  selectedCalendarId: string;
  integration: string;
  externalId: string;
};

export type ExternalCalendarEventDto = {
  key: string; // `${selectedCalendarId}:${externalId}`
  title: string | null;
  start: Date;
  end: Date;
  isAllDay: boolean;
  status: "confirmed" | "tentative";
  selfResponse: "accepted" | "tentative" | "needsAction" | "organizer" | null;
  attendeesCount: number;
  meetingUrl: string | null;
  meetingPlatform: NotetakerPlatformDto | null;
  calendar: ExternalCalendarEventCalendarDto;
};

export type ExternalCalendarEventsDto = {
  available: boolean;
  events: ExternalCalendarEventDto[];
  failedCalendarCount: number;
};
