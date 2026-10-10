import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  EventTypeNotetakerSettingsRecord,
  IEventTypeNotetakerSettingsRepository,
  NotetakerEventTypeContext,
  NotetakerSharedEventTypeRecord,
  NotetakerSharingChangeRecord,
  NotetakerSharingMemberRecord,
} from "./interfaces/IEventTypeNotetakerSettingsRepository";

const settingsSelect = {
  eventTypeId: true,
  enabledByDefault: true,
  updatedAt: true,
  sharingMode: true,
  sharingSetByUserId: true,
  sharingSetAt: true,
} satisfies Prisma.EventTypeNotetakerSettingsSelect;

const sharingChangeSelect = {
  id: true,
  eventTypeId: true,
  actorUserId: true,
  actorName: true,
  previousMode: true,
  newMode: true,
  addedUserNames: true,
  removedUserNames: true,
  createdAt: true,
} satisfies Prisma.EventTypeNotetakerSharingChangeSelect;

const sharedEventTypeSelect = {
  id: true,
  title: true,
  teamId: true,
  team: { select: { name: true, parentId: true } },
  notetakerSettings: { select: { sharingMode: true } },
} satisfies Prisma.EventTypeSelect;

function toSharedEventTypeRecord(
  row: Prisma.EventTypeGetPayload<{ select: typeof sharedEventTypeSelect }>
): NotetakerSharedEventTypeRecord | null {
  if (row.teamId === null || row.team === null) return null;
  return {
    eventTypeId: row.id,
    eventTypeTitle: row.title,
    teamId: row.teamId,
    teamName: row.team.name,
    organizationId: row.team.parentId,
    sharingMode: row.notetakerSettings?.sharingMode ?? "HOSTS_ONLY",
  };
}

export class PrismaEventTypeNotetakerSettingsRepository implements IEventTypeNotetakerSettingsRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByEventTypeId(eventTypeId: number): Promise<EventTypeNotetakerSettingsRecord | null> {
    return this.prismaClient.eventTypeNotetakerSettings.findUnique({
      where: { eventTypeId },
      select: settingsSelect,
    });
  }

  async upsert(data: {
    eventTypeId: number;
    enabledByDefault: boolean;
  }): Promise<EventTypeNotetakerSettingsRecord> {
    const { eventTypeId, enabledByDefault } = data;
    return this.prismaClient.eventTypeNotetakerSettings.upsert({
      where: { eventTypeId },
      create: { eventTypeId, enabledByDefault },
      update: { enabledByDefault },
      select: settingsSelect,
    });
  }

  async findByEventTypeIdIncludeEventType(eventTypeId: number): Promise<NotetakerEventTypeContext | null> {
    const row = await this.prismaClient.eventType.findUnique({
      where: { id: eventTypeId },
      select: {
        id: true,
        userId: true,
        teamId: true,
        locations: true,
        title: true,
        owner: { select: { name: true } },
        team: { select: { name: true, parentId: true } },
        notetakerSettings: { select: settingsSelect },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      teamId: row.teamId,
      locations: row.locations,
      ownerName: row.team?.name ?? row.owner?.name ?? null,
      title: row.title,
      teamName: row.team?.name ?? null,
      organizationId: row.team?.parentId ?? null,
      settings: row.notetakerSettings,
    };
  }

  async updateSharing(data: {
    eventTypeId: number;
    sharingMode: NotetakerSharingModeDto;
    sharingSetByUserId: number | null;
    sharingSetAt: Date;
    memberUserIds?: number[];
    change: Omit<NotetakerSharingChangeRecord, "id" | "eventTypeId" | "createdAt">;
  }): Promise<void> {
    const { eventTypeId, sharingMode, sharingSetByUserId, sharingSetAt, memberUserIds, change } = data;
    const sharingFields = { sharingMode, sharingSetByUserId, sharingSetAt };

    // One transaction so a reader never sees the new mode with the old list, and the audit row
    // exists exactly when the change was applied.
    await this.prismaClient.$transaction([
      this.prismaClient.eventTypeNotetakerSettings.upsert({
        where: { eventTypeId },
        create: { eventTypeId, enabledByDefault: false, ...sharingFields },
        update: sharingFields,
        select: { eventTypeId: true },
      }),
      ...(memberUserIds !== undefined
        ? [
            this.prismaClient.eventTypeNotetakerSharingMember.deleteMany({
              where: { eventTypeId, userId: { notIn: memberUserIds } },
            }),
            this.prismaClient.eventTypeNotetakerSharingMember.createMany({
              data: memberUserIds.map((userId) => ({
                eventTypeId,
                userId,
                addedByUserId: sharingSetByUserId,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
      this.prismaClient.eventTypeNotetakerSharingChange.create({
        data: {
          eventTypeId,
          actorUserId: change.actorUserId,
          actorName: change.actorName,
          previousMode: change.previousMode,
          newMode: change.newMode,
          addedUserNames: change.addedUserNames,
          removedUserNames: change.removedUserNames,
        },
        select: { id: true },
      }),
    ]);
  }

  async findSharingMembersIncludeUser(eventTypeId: number): Promise<NotetakerSharingMemberRecord[]> {
    const rows = await this.prismaClient.eventTypeNotetakerSharingMember.findMany({
      where: { eventTypeId },
      orderBy: [{ addedAt: "asc" }, { userId: "asc" }],
      select: {
        userId: true,
        addedAt: true,
        user: { select: { name: true, email: true, avatarUrl: true } },
      },
    });
    return rows.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      avatarUrl: row.user.avatarUrl,
      addedAt: row.addedAt,
    }));
  }

  async hasSharingMember(params: { eventTypeId: number; userId: number }): Promise<boolean> {
    const row = await this.prismaClient.eventTypeNotetakerSharingMember.findUnique({
      where: { eventTypeId_userId: { eventTypeId: params.eventTypeId, userId: params.userId } },
      select: { userId: true },
    });
    return row !== null;
  }

  async findSharingChangesByEventTypeIdSince(params: {
    eventTypeId: number;
    since: Date;
    limit: number;
  }): Promise<NotetakerSharingChangeRecord[]> {
    return await this.prismaClient.eventTypeNotetakerSharingChange.findMany({
      where: { eventTypeId: params.eventTypeId, createdAt: { gte: params.since } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit,
      select: sharingChangeSelect,
    });
  }

  async findByTeamIdsAndSharingModeIncludeEventType(params: {
    teamIds: number[];
    sharingMode: NotetakerSharingModeDto;
  }): Promise<NotetakerSharedEventTypeRecord[]> {
    if (params.teamIds.length === 0) return [];
    const rows = await this.prismaClient.eventType.findMany({
      where: {
        teamId: { in: params.teamIds },
        notetakerSettings: { is: { sharingMode: params.sharingMode } },
      },
      orderBy: { id: "asc" },
      select: sharedEventTypeSelect,
    });
    return rows.flatMap((row) => toSharedEventTypeRecord(row) ?? []);
  }

  async findBySharingMemberUserIdIncludeEventType(params: {
    userId: number;
  }): Promise<NotetakerSharedEventTypeRecord[]> {
    const rows = await this.prismaClient.eventTypeNotetakerSharingMember.findMany({
      where: { userId: params.userId },
      orderBy: { eventTypeId: "asc" },
      select: { eventType: { select: sharedEventTypeSelect } },
    });
    return rows.flatMap((row) => toSharedEventTypeRecord(row.eventType) ?? []);
  }
}
