import type { NotetakerAutoJoinCalendarRecord } from "../../calendar/INotetakerCalendarEventsGateway";

export type NotetakerCalendarAutoJoinSettingRecord = {
  selectedCalendarId: string;
  enabled: boolean;
  sharingTeamId: number | null;
};

export type NotetakerUserLevelSelectedCalendarRecord = {
  id: string;
  integration: string;
};

export type NotetakerUserLevelSelectedCalendarWithAutoJoinRecord = {
  id: string;
  integration: string;
  externalId: string;
  autoJoin: { enabled: boolean; sharingTeamId: number | null; lastPollError: string | null } | null;
};

export interface INotetakerCalendarAutoJoinRepository {
  /**
   * Enabled rows never polled or last polled before `polledBefore`, limited to user-level selected
   * calendars of the given integrations. Ordered by lastPolledAt asc, never-polled first.
   */
  findDueForPoll(params: {
    polledBefore: Date;
    integrations: string[];
    limit: number;
  }): Promise<NotetakerAutoJoinCalendarRecord[]>;
  /** `error` null clears a previous poll error. */
  markPolled(params: { selectedCalendarId: string; at: Date; error: string | null }): Promise<void>;
  findByUserId(userId: number): Promise<NotetakerCalendarAutoJoinSettingRecord[]>;
  upsert(params: {
    selectedCalendarId: string;
    userId: number;
    enabled: boolean;
    sharingTeamId: number | null;
  }): Promise<void>;
  /** null unless the row is a user-level (no event type) selected calendar of that user. */
  findUserLevelSelectedCalendar(params: {
    selectedCalendarId: string;
    userId: number;
  }): Promise<NotetakerUserLevelSelectedCalendarRecord | null>;
  /** Every user-level selected calendar of the user, with its auto-join row when one exists. */
  findUserLevelSelectedCalendarsIncludeAutoJoin(params: {
    userId: number;
  }): Promise<NotetakerUserLevelSelectedCalendarWithAutoJoinRecord[]>;
}
