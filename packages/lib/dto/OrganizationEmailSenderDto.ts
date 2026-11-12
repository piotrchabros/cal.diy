import { z } from "zod";
import type { OrganizationSmtpTransportConfig } from "./OrganizationSmtpSettingsDto";

export type EmailSenderScope =
  | { organizationId: number }
  | { teamId: number }
  | { userId: number }
  | { eventTypeId: number }
  | { userEmail: string };

export type OrganizationEmailSenderDto = { name: string | null; address: string | null };

// Server-only: smtp carries the decrypted password
export type OrganizationEmailDeliveryDto = {
  sender: OrganizationEmailSenderDto | null;
  smtp: OrganizationSmtpTransportConfig | null;
};

export const ORGANIZATION_EMAIL_SENDER_NAME_MAX_LENGTH = 100;

export const OrganizationEmailSenderSettingsDtoSchema = z.object({
  senderName: z.string().nullable(),
  senderAddress: z.string().nullable(),
  senderAddressActive: z.boolean(),
  allowedDomain: z.string().nullable(),
  fallbackSenderName: z.string(),
  fallbackSenderAddress: z.string().nullable(),
  canEdit: z.boolean(),
  usesOrganizationSmtp: z.boolean(),
});

export type OrganizationEmailSenderSettingsDto = z.infer<typeof OrganizationEmailSenderSettingsDtoSchema>;
