import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  IOrganizationNotetakerSettingsRepository,
  OrganizationNotetakerSettingsRecord,
} from "./interfaces/IOrganizationNotetakerSettingsRepository";

// botImageJpeg is deliberately absent: only findBotImageByOrganizationId may load the blob.
const recordSelect = {
  organizationId: true,
  botName: true,
  botImageUpdatedAt: true,
} satisfies Prisma.OrganizationNotetakerSettingsSelect;

export class PrismaOrganizationNotetakerSettingsRepository
  implements IOrganizationNotetakerSettingsRepository
{
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByOrganizationId(organizationId: number): Promise<OrganizationNotetakerSettingsRecord | null> {
    return this.prismaClient.organizationNotetakerSettings.findUnique({
      where: { organizationId },
      select: recordSelect,
    });
  }

  async findByUserId(userId: number): Promise<OrganizationNotetakerSettingsRecord | null> {
    const user = await this.prismaClient.user.findUnique({
      where: { id: userId },
      select: { organization: { select: { notetakerOrganizationSettings: { select: recordSelect } } } },
    });
    return user?.organization.notetakerOrganizationSettings ?? null;
  }

  async findBotImageByOrganizationId(organizationId: number): Promise<string | null> {
    const row = await this.prismaClient.organizationNotetakerSettings.findUnique({
      where: { organizationId },
      select: { botImageJpeg: true },
    });
    return row?.botImageJpeg ?? null;
  }

  async upsertBotName(
    organizationId: number,
    botName: string | null
  ): Promise<OrganizationNotetakerSettingsRecord> {
    return this.prismaClient.organizationNotetakerSettings.upsert({
      where: { organizationId },
      create: { organizationId, botName },
      update: { botName },
      select: recordSelect,
    });
  }

  async upsertBotImage(
    organizationId: number,
    botImageJpeg: string | null,
    at: Date
  ): Promise<OrganizationNotetakerSettingsRecord> {
    const fields = { botImageJpeg, botImageUpdatedAt: botImageJpeg === null ? null : at };
    return this.prismaClient.organizationNotetakerSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...fields },
      update: fields,
      select: recordSelect,
    });
  }
}
