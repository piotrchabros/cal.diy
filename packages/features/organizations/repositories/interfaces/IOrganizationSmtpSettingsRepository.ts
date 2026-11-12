import type { OrganizationSmtpSecurity } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";

export type OrganizationSmtpSettingsRecord = {
  organizationId: number;
  host: string;
  port: number;
  security: OrganizationSmtpSecurity;
  username: string | null;
  passwordEncrypted: string | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
};

export type OrganizationSmtpSettingsInput = {
  host: string;
  port: number;
  security: OrganizationSmtpSecurity;
  username: string | null;
  passwordEncrypted: string | null;
};

export interface IOrganizationSmtpSettingsRepository {
  findByOrganizationId(organizationId: number): Promise<OrganizationSmtpSettingsRecord | null>;
  upsert(
    organizationId: number,
    data: OrganizationSmtpSettingsInput
  ): Promise<OrganizationSmtpSettingsRecord>;
  delete(organizationId: number): Promise<void>;
  markVerified(organizationId: number, at: Date): Promise<void>;
}
