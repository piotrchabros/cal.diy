import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { NotetakerAutoJoinCalendarRecord } from "../calendar/INotetakerCalendarEventsGateway";
import type {
  INotetakerCalendarAutoJoinRepository,
  NotetakerCalendarAutoJoinSettingRecord,
  NotetakerUserLevelSelectedCalendarRecord,
  NotetakerUserLevelSelectedCalendarWithAutoJoinRecord,
} from "./interfaces/INotetakerCalendarAutoJoinRepository";

const dueSelect = {
  selectedCalendarId: true,
  userId: true,
  sharingTeamId: true,
  lastPolledAt: true,
  selectedCalendar: {
    select: { integration: true, externalId: true, credentialId: true, delegationCredentialId: true },
  },
} satisfies Prisma.NotetakerCalendarAutoJoinSelect;

const settingSelect = {
  selectedCalendarId: true,
  enabled: true,
  sharingTeamId: true,
} satisfies Prisma.NotetakerCalendarAutoJoinSelect;

export class PrismaNotetakerCalendarAutoJoinRepository implements INotetakerCalendarAutoJoinRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findDueForPoll(params: {
    polledBefore: Date;
    integrations: string[];
    limit: number;
  }): Promise<NotetakerAutoJoinCalendarRecord[]> {
    if (params.integrations.length === 0) return [];

    const rows = await this.prismaClient.notetakerCalendarAutoJoin.findMany({
      where: {
        enabled: true,
        OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: params.polledBefore } }],
        selectedCalendar: { eventTypeId: null, integration: { in: params.integrations } },
      },
      orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }],
      take: params.limit,
      select: dueSelect,
    });
    return rows.map(({ selectedCalendar, ...row }) => ({
      selectedCalendarId: row.selectedCalendarId,
      userId: row.userId,
      integration: selectedCalendar.integration,
      externalId: selectedCalendar.externalId,
      credentialId: selectedCalendar.credentialId,
      delegationCredentialId: selectedCalendar.delegationCredentialId,
      sharingTeamId: row.sharingTeamId,
      lastPolledAt: row.lastPolledAt,
    }));
  }

  async markPolled(params: { selectedCalendarId: string; at: Date; error: string | null }): Promise<void> {
    // updateMany so a calendar deselected mid-poll (row deleted) is a no-op instead of a P2025 throw.
    await this.prismaClient.notetakerCalendarAutoJoin.updateMany({
      where: { selectedCalendarId: params.selectedCalendarId },
      data: { lastPolledAt: params.at, lastPollError: params.error },
    });
  }

  async findByUserId(userId: number): Promise<NotetakerCalendarAutoJoinSettingRecord[]> {
    return await this.prismaClient.notetakerCalendarAutoJoin.findMany({
      where: { userId },
      orderBy: { selectedCalendarId: "asc" },
      select: settingSelect,
    });
  }

  async upsert(params: {
    selectedCalendarId: string;
    userId: number;
    enabled: boolean;
    sharingTeamId: number | null;
  }): Promise<void> {
    const { selectedCalendarId, userId, enabled, sharingTeamId } = params;
    await this.prismaClient.notetakerCalendarAutoJoin.upsert({
      where: { selectedCalendarId },
      create: { selectedCalendarId, userId, enabled, sharingTeamId },
      update: { enabled, sharingTeamId },
      select: { selectedCalendarId: true },
    });
  }

  async findUserLevelSelectedCalendar(params: {
    selectedCalendarId: string;
    userId: number;
  }): Promise<NotetakerUserLevelSelectedCalendarRecord | null> {
    return await this.prismaClient.selectedCalendar.findFirst({
      where: { id: params.selectedCalendarId, userId: params.userId, eventTypeId: null },
      select: { id: true, integration: true },
    });
  }

  async findUserLevelSelectedCalendarsIncludeAutoJoin(params: {
    userId: number;
  }): Promise<NotetakerUserLevelSelectedCalendarWithAutoJoinRecord[]> {
    const rows = await this.prismaClient.selectedCalendar.findMany({
      where: { userId: params.userId, eventTypeId: null },
      orderBy: [{ integration: "asc" }, { externalId: "asc" }],
      select: {
        id: true,
        integration: true,
        externalId: true,
        notetakerAutoJoin: { select: { enabled: true, sharingTeamId: true, lastPollError: true } },
      },
    });
    return rows.map(({ notetakerAutoJoin, ...row }) => ({ ...row, autoJoin: notetakerAutoJoin }));
  }
}
