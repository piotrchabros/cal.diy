import type { ExternalCalendarRef } from "../../lib/externalCalendarEvents";

export type ExternalCalendarBookingMatchKeys = {
  iCalUIDs: string[];
  referenceUids: string[];
};

export type ExternalCalendarMeetingEventKey = {
  selectedCalendarId: string;
  externalEventId: string;
};

export type ExternalCalendarBookedLocation = {
  location: string;
  startTime: Date;
  endTime: Date;
};

export interface IExternalCalendarEventsRepository {
  findUserLevelSelectedCalendarsByIntegrations(params: {
    userId: number;
    integrations: string[];
  }): Promise<ExternalCalendarRef[]>;

  /** Keys of live bookings the user hosts or attends that are backed by one of the given calendar events. */
  findLiveBookingMatchKeysForUser(params: {
    userId: number;
    userEmail: string;
    iCalUIDs: string[];
    referenceUids: string[];
  }): Promise<ExternalCalendarBookingMatchKeys>;

  findActiveCalendarMeetingEventKeysByUserId(params: {
    userId: number;
    selectedCalendarIds: string[];
  }): Promise<ExternalCalendarMeetingEventKey[]>;

  findLiveBookingLocationsByUserIdInRange(params: {
    userId: number;
    locations: string[];
    from: Date;
    to: Date;
  }): Promise<ExternalCalendarBookedLocation[]>;
}
