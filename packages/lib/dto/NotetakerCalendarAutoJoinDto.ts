import type { NotetakerSharingTeamOptionDto } from "./NotetakerEventTypeSharingDto";

export type NotetakerCalendarAutoJoinSettingDto = {
  selectedCalendarId: string;
  /** With externalId, matches the entry in the user's selected-calendars list. */
  integration: string;
  externalId: string;
  enabled: boolean;
  sharingTeamId: number | null;
  /** False when no events gateway exists for the integration yet, so the switch cannot be turned on. */
  supported: boolean;
  /** The raw poll error stays server-side; the UI only needs to know the last poll failed. */
  lastPollFailed: boolean;
};

export type NotetakerCalendarAutoJoinSettingsDto = {
  available: boolean;
  teamOptions: NotetakerSharingTeamOptionDto[];
  calendars: NotetakerCalendarAutoJoinSettingDto[];
};
