import { z } from "zod";

export const ORGANIZATION_SMTP_ALLOWED_PORTS = [25, 465, 587, 2525] as const;

export const OrganizationSmtpSecuritySchema = z.enum(["SSL", "STARTTLS", "NONE"]);

export type OrganizationSmtpSecurity = z.infer<typeof OrganizationSmtpSecuritySchema>;

export const OrganizationSmtpSettingsDtoSchema = z.object({
  configured: z.boolean(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  security: OrganizationSmtpSecuritySchema.nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  lastVerifiedAt: z.string().nullable(),
  canEdit: z.boolean(),
});

export type OrganizationSmtpSettingsDto = z.infer<typeof OrganizationSmtpSettingsDtoSchema>;

// Server-only: carries the decrypted password, so it must never be returned through tRPC.
export type OrganizationSmtpTransportConfig = {
  organizationId: number;
  version: string;
  host: string;
  port: number;
  security: OrganizationSmtpSecurity;
  username: string | null;
  password: string | null;
};
