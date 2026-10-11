import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";

export type EventTypeNotetakerSettingsRecord = {
  eventTypeId: number;
  enabledByDefault: boolean;
  updatedAt: Date;
  sharingMode: NotetakerSharingModeDto;
  sharingSetByUserId: number | null;
  sharingSetAt: Date | null;
  /** Stored value. Read only for a personal event type; see effectiveSharingTeamId for the team in force. */
  sharingTeamId: number | null;
};

export type NotetakerEventTypeContext = {
  id: number;
  userId: number | null;
  /** The event type's own team, which tells a team event type from a personal one. */
  teamId: number | null;
  locations: unknown;
  ownerName: string | null;
  title: string;
  teamName: string | null;
  organizationId: number | null;
  /** The own team, else the team chosen on a personal event type that has an owner, else null. */
  effectiveSharingTeamId: number | null;
  effectiveSharingTeamName: string | null;
  /** Owner of a personal event type that has a chosen team; null otherwise. */
  sharingOwnerUserId: number | null;
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
  /** Name of the effective sharing team before the change, as it was then. */
  previousTeamName: string | null;
  newTeamName: string | null;
  createdAt: Date;
};

export type NotetakerSharedEventTypeRecord = {
  eventTypeId: number;
  eventTypeTitle: string;
  /** The effective sharing team. */
  teamId: number;
  teamName: string;
  /** Null for a personal event type. */
  organizationId: number | null;
  /** Owner of a personal event type, who must stay an accepted member of teamId. Null for a team event type. */
  sharingOwnerUserId: number | null;
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
   * change row. sharingTeamId undefined leaves the column alone (null on create); team names left
   * out of the change are stored as null.
   */
  updateSharing(data: {
    eventTypeId: number;
    sharingMode: NotetakerSharingModeDto;
    sharingSetByUserId: number | null;
    sharingSetAt: Date;
    memberUserIds?: number[];
    sharingTeamId?: number | null;
    change: Omit<
      NotetakerSharingChangeRecord,
      "id" | "eventTypeId" | "createdAt" | "previousTeamName" | "newTeamName"
    > & { previousTeamName?: string | null; newTeamName?: string | null };
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
  /**
   * Event types whose settings row has this mode and whose effective sharing team is one of these:
   * team event types by their own team, personal event types by the team their owner chose.
   * Empty teamIds gives [].
   */
  findByTeamIdsAndSharingModeIncludeEventType(params: {
    teamIds: number[];
    sharingMode: NotetakerSharingModeDto;
  }): Promise<NotetakerSharedEventTypeRecord[]>;
  /**
   * Event types with an effective sharing team on whose list the user is, whatever the mode: team
   * event types and personal event types with a chosen team. Starts from the member table (userId index).
   */
  findBySharingMemberUserIdIncludeEventType(params: {
    userId: number;
  }): Promise<NotetakerSharedEventTypeRecord[]>;
  /** Non-organization teams, ordered by name asc then id asc. Empty teamIds gives [] without a query. */
  findTeamsByIds(params: { teamIds: number[] }): Promise<{ teamId: number; teamName: string }[]>;
}
