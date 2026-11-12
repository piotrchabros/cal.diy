import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  IOrganizationEmailSenderRepository,
  OrganizationEmailSenderRecord,
} from "./interfaces/IOrganizationEmailSenderRepository";

const settingsSelect = {
  organizationId: true,
  emailFromName: true,
  emailFromAddress: true,
  customDomain: true,
  organization: {
    select: {
      organizationSmtpSettings: {
        select: {
          host: true,
          port: true,
          security: true,
          username: true,
          passwordEncrypted: true,
          updatedAt: true,
        },
      },
    },
  },
} as const;

type SettingsRow = Prisma.OrganizationSettingsGetPayload<{ select: typeof settingsSelect }>;

function toRecord(row: SettingsRow): OrganizationEmailSenderRecord {
  const { organization, ...settings } = row;
  return { ...settings, smtp: organization.organizationSmtpSettings };
}

export class PrismaOrganizationEmailSenderRepository implements IOrganizationEmailSenderRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByOrganizationId(organizationId: number): Promise<OrganizationEmailSenderRecord | null> {
    const row = await this.prismaClient.organizationSettings.findUnique({
      where: { organizationId },
      select: settingsSelect,
    });
    return row ? toRecord(row) : null;
  }

  async update(
    organizationId: number,
    input: { emailFromName: string | null; emailFromAddress: string | null }
  ): Promise<OrganizationEmailSenderRecord | null> {
    const organization = await this.prismaClient.team.findFirst({
      where: { id: organizationId, isOrganization: true, parentId: null },
      select: { id: true },
    });
    if (!organization) return null;

    const row = await this.prismaClient.organizationSettings.upsert({
      where: { organizationId },
      create: {
        organizationId,
        ...input,
        orgAutoAcceptEmail: "",
        isOrganizationConfigured: true,
        isOrganizationVerified: true,
        allowSEOIndexing: true,
      },
      update: input,
      select: settingsSelect,
    });
    return toRecord(row);
  }

  async findOrganizationIdByUserId(userId: number): Promise<number | null> {
    const user = await this.prismaClient.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    return user?.organizationId ?? null;
  }

  async findOrganizationIdByUserEmail(email: string): Promise<number | null> {
    // users.email is stored lowercase (see UserRepository)
    const user = await this.prismaClient.user.findFirst({
      where: { email: email.toLowerCase() },
      select: { organizationId: true },
    });
    return user?.organizationId ?? null;
  }

  async findOrganizationIdByTeamId(teamId: number): Promise<number | null> {
    const team = await this.prismaClient.team.findUnique({
      where: { id: teamId },
      select: { id: true, isOrganization: true, parentId: true },
    });
    if (!team) return null;
    return team.isOrganization ? team.id : team.parentId;
  }

  async findOrganizationIdByEventTypeId(eventTypeId: number): Promise<number | null> {
    const eventType = await this.prismaClient.eventType.findUnique({
      where: { id: eventTypeId },
      select: { teamId: true, userId: true },
    });
    if (!eventType) return null;
    if (eventType.teamId !== null) return this.findOrganizationIdByTeamId(eventType.teamId);
    if (eventType.userId !== null) return this.findOrganizationIdByUserId(eventType.userId);
    return null;
  }
}
