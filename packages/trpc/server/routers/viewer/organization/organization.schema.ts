import { OrganizationRoleDtoSchema } from "@calcom/lib/dto/OrganizationDto";
import { OrganizationSmtpSecuritySchema } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { z } from "zod";

const id = z.number().int().positive();

export const ZListOrganizationMembersInput = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const ZListOrganizationTeamsInput = ZListOrganizationMembersInput;

export const ZInviteOrganizationMemberInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: OrganizationRoleDtoSchema,
});

export const ZInviteOrganizationMemberOutput = z.object({ invited: z.literal(true) });

export const ZUpdateOrganizationMemberRoleInput = z.object({ userId: id, role: OrganizationRoleDtoSchema });

export const ZUpdateOrganizationMemberRoleOutput = ZUpdateOrganizationMemberRoleInput;

export const ZUpdateOrganizationNameInput = z.object({ name: z.string().max(100) });

export const ZUpdateOrganizationLogoInput = z.object({ logo: z.string().max(8_000_000).nullable() });

export type TUpdateOrganizationLogoInput = z.infer<typeof ZUpdateOrganizationLogoInput>;

export const ZRemoveOrganizationMemberInput = z.object({
  userId: id,
  newUsername: z.string().trim().min(1).max(255).optional(),
});

export const ZRemoveOrganizationMemberOutput = z.object({ userId: id });

export const ZUpdateOrganizationNotetakerSettingsInput = z
  .object({
    // Loose caps only bound the payload; the service owns the real name and image rules
    botName: z.string().max(200).nullable().optional(),
    botImage: z.string().max(1_000_000).nullable().optional(),
  })
  .refine((value) => value.botName !== undefined || value.botImage !== undefined, {
    message: "Provide botName or botImage",
  });

export const ZUpdateOrganizationEmailSenderInput = z
  .object({
    // Loose caps only bound the payload; the service owns the real name and address rules
    senderName: z.string().max(300).nullable().optional(),
    senderAddress: z.string().max(300).nullable().optional(),
  })
  .refine((value) => value.senderName !== undefined || value.senderAddress !== undefined, {
    message: "Provide senderName or senderAddress",
  });

export const ZUpdateOrganizationSmtpSettingsInput = z.object({
  // Loose caps only bound the payload; the service owns the real host, port and username rules
  host: z.string().max(253),
  port: z.number().int(),
  security: OrganizationSmtpSecuritySchema,
  username: z.string().max(320).nullable(),
  password: z.string().max(1024).optional(),
});

export const ZTestOrganizationSmtpSettingsInput = z.object({ sendTestEmail: z.boolean() });

export const ZTestOrganizationSmtpSettingsOutput = z.object({ ok: z.literal(true) });

export type TListOrganizationMembersInput = z.infer<typeof ZListOrganizationMembersInput>;
export type TListOrganizationTeamsInput = z.infer<typeof ZListOrganizationTeamsInput>;
export type TInviteOrganizationMemberInput = z.infer<typeof ZInviteOrganizationMemberInput>;
export type TInviteOrganizationMemberOutput = z.infer<typeof ZInviteOrganizationMemberOutput>;
export type TUpdateOrganizationMemberRoleInput = z.infer<typeof ZUpdateOrganizationMemberRoleInput>;
export type TUpdateOrganizationMemberRoleOutput = z.infer<typeof ZUpdateOrganizationMemberRoleOutput>;
export type TUpdateOrganizationNameInput = z.infer<typeof ZUpdateOrganizationNameInput>;
export type TRemoveOrganizationMemberInput = z.infer<typeof ZRemoveOrganizationMemberInput>;
export type TRemoveOrganizationMemberOutput = z.infer<typeof ZRemoveOrganizationMemberOutput>;
export type TUpdateOrganizationEmailSenderInput = z.infer<typeof ZUpdateOrganizationEmailSenderInput>;
export type TUpdateOrganizationNotetakerSettingsInput = z.infer<
  typeof ZUpdateOrganizationNotetakerSettingsInput
>;
export type TUpdateOrganizationSmtpSettingsInput = z.infer<typeof ZUpdateOrganizationSmtpSettingsInput>;
export type TTestOrganizationSmtpSettingsInput = z.infer<typeof ZTestOrganizationSmtpSettingsInput>;
