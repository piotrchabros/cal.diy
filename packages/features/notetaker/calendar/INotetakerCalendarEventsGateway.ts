import type { NotetakerCalendarEvent } from "../lib/calendarMeeting";

export type NotetakerAutoJoinCalendarRecord = {
  selectedCalendarId: string;
  userId: number;
  integration: string;
  externalId: string;
  credentialId: number | null;
  delegationCredentialId: string | null;
  sharingTeamId: number | null;
  lastPolledAt: Date | null;
};

export interface INotetakerCalendarEventsGateway {
  /** Rejects when the calendar's credential is unusable or on a provider or network error. */
  listEvents(p: {
    calendar: NotetakerAutoJoinCalendarRecord;
    timeMin: Date;
    timeMax: Date;
  }): Promise<NotetakerCalendarEvent[]>;
}

export interface INotetakerCalendarEventsGatewayResolver {
  /** null when the integration has no events gateway */
  resolve(integration: string): INotetakerCalendarEventsGateway | null;
  supportedIntegrations(): string[];
}
