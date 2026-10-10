import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";

export type EventTypeNotetakerSettingsRecord = {
  eventTypeId: number;
  enabledByDefault: boolean;
  updatedAt: Date;
  sharingMode: NotetakerSharingModeDto;
  sharingSetByUserId: number | null;
  sharingSetAt: Date | null;
};

export type NotetakerEventTypeContext = {
  id: number;
  userId: number | null;
  teamId: number | null;
  locations: unknown;
  ownerName: string | null;
  title: string;
  teamName: string | null;
  organizationId: number | null;
  settings: EventTypeNotetakerSettingsRecord | null;
};

export type NotetakerSharingMemberRecord = {
  userId: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  addedAt: Date;
};

export type NotetakerSharingChangeRecord = {
  id: string;
  eventTypeId: number;
  actorUserId: number | null;
  actorName: string | null;
  previousMode: NotetakerSharingModeDto;
  newMode: NotetakerSharingModeDto;
  addedUserNames: string[];
  removedUserNames: string[];
  createdAt: Date;
};

export type NotetakerSharedEventTypeRecord = {
  eventTypeId: number;
  eventTypeTitle: string;
  teamId: number;
  teamName: string;
  organizationId: number | null;
  sharingMode: NotetakerSharingModeDto;
};

export interface IEventTypeNotetakerSettingsRepository {
  findByEventTypeId(eventTypeId: number): Promise<EventTypeNotetakerSettingsRecord | null>;
  /** Never writes the sharing columns. */
  upsert(data: { eventTypeId: number; enabledByDefault: boolean }): Promise<EventTypeNotetakerSettingsRecord>;
  findByEventTypeIdIncludeEventType(eventTypeId: number): Promise<NotetakerEventTypeContext | null>;
  /**
   * One transaction: upserts mode and stamp (create with enabledByDefault false), replaces the member
   * list when memberUserIds is given (rows that stay keep addedAt and addedByUserId), inserts the
   * change row.
   */
  updateSharing(data: {
    eventTypeId: number;
    sharingMode: NotetakerSharingModeDto;
    sharingSetByUserId: number | null;
    sharingSetAt: Date;
    memberUserIds?: number[];
    change: Omit<NotetakerSharingChangeRecord, "id" | "eventTypeId" | "createdAt">;
  }): Promise<void>;
  /** Ordered by addedAt asc, userId asc. */
  findSharingMembersIncludeUser(eventTypeId: number): Promise<NotetakerSharingMemberRecord[]>;
  hasSharingMember(params: { eventTypeId: number; userId: number }): Promise<boolean>;
  /** createdAt >= since, ordered by createdAt desc, id desc. */
  findSharingChangesByEventTypeIdSince(params: {
    eventTypeId: number;
    since: Date;
    limit: number;
  }): Promise<NotetakerSharingChangeRecord[]>;
  /** Team event types of these teams whose settings row has this mode. Empty teamIds gives []. */
  findByTeamIdsAndSharingModeIncludeEventType(params: {
    teamIds: number[];
    sharingMode: NotetakerSharingModeDto;
  }): Promise<NotetakerSharedEventTypeRecord[]>;
  /** Team event types on whose list the user is, whatever the mode. Starts from the member table (userId index). */
  findBySharingMemberUserIdIncludeEventType(params: {
    userId: number;
  }): Promise<NotetakerSharedEventTypeRecord[]>;
}
