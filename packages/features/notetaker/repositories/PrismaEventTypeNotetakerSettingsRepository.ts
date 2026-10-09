import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  EventTypeNotetakerSettingsRecord,
  IEventTypeNotetakerSettingsRepository,
  NotetakerEventTypeContext,
} from "./interfaces/IEventTypeNotetakerSettingsRepository";

const settingsSelect = {
  eventTypeId: true,
  enabledByDefault: true,
  updatedAt: true,
} satisfies Prisma.EventTypeNotetakerSettingsSelect;

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
        owner: { select: { name: true } },
        team: { select: { name: true } },
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
      settings: row.notetakerSettings,
    };
  }
}
