import type { OrganizationSmtpSecurity } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import type { PrismaClient } from "@calcom/prisma";
import type {
  IOrganizationSmtpSettingsRepository,
  OrganizationSmtpSettingsInput,
  OrganizationSmtpSettingsRecord,
} from "./interfaces/IOrganizationSmtpSettingsRepository";

const settingsSelect = {
  organizationId: true,
  host: true,
  port: true,
  security: true,
  username: true,
  passwordEncrypted: true,
  lastVerifiedAt: true,
  updatedAt: true,
} as const;

type SelectedRow = {
  organizationId: number;
  host: string;
  port: number;
  security: string;
  username: string | null;
  passwordEncrypted: string | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
};

function toSecurity(value: string): OrganizationSmtpSecurity {
  switch (value) {
    case "SSL":
    case "STARTTLS":
    case "NONE":
      return value;
    default:
      throw new Error(`Unknown organization SMTP security mode: ${value}`);
  }
}

function toRecord(row: SelectedRow): OrganizationSmtpSettingsRecord {
  return { ...row, security: toSecurity(row.security) };
}

export class PrismaOrganizationSmtpSettingsRepository implements IOrganizationSmtpSettingsRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByOrganizationId(organizationId: number): Promise<OrganizationSmtpSettingsRecord | null> {
    const row = await this.prismaClient.organizationSmtpSettings.findUnique({
      where: { organizationId },
      select: settingsSelect,
    });
    return row ? toRecord(row) : null;
  }

  async upsert(
    organizationId: number,
    data: OrganizationSmtpSettingsInput
  ): Promise<OrganizationSmtpSettingsRecord> {
    const row = await this.prismaClient.organizationSmtpSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
      select: settingsSelect,
    });
    return toRecord(row);
  }

  async delete(organizationId: number): Promise<void> {
    await this.prismaClient.organizationSmtpSettings.deleteMany({ where: { organizationId } });
  }

  async markVerified(organizationId: number, at: Date): Promise<void> {
    await this.prismaClient.organizationSmtpSettings.updateMany({
      where: { organizationId },
      data: { lastVerifiedAt: at },
    });
  }
}
