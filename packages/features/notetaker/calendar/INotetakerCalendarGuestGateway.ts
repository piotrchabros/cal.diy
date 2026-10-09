export type NotetakerCalendarEventRef = {
  credentialId: number;
  eventId: string;
  /** null means the credential's primary calendar */
  calendarId: string | null;
};

export type NotetakerCalendarGuestOutcome =
  | "ADDED"
  | "ALREADY_PRESENT"
  | "NOT_THE_MEETING_EVENT"
  | "CREDENTIAL_UNAVAILABLE";

export interface INotetakerCalendarGuestGateway {
  /**
   * Makes guestEmail a guest of the event, if and only if the event's own conference is meetingUrl.
   * Changes nothing but the guest list and sends no notification. Rejects on a provider or network error.
   */
  ensureGuest(params: {
    event: NotetakerCalendarEventRef;
    guestEmail: string;
    meetingUrl: string;
  }): Promise<NotetakerCalendarGuestOutcome>;
}
