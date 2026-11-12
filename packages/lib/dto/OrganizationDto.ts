import { z } from "zod";

export const OrganizationOwnerDtoSchema = z.object({
  userId: z.number(),
  name: z.string().nullable(),
  email: z.string(),
});

export const OrganizationListItemDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
  domain: z.string().nullable(),
  isDefault: z.boolean(),
  memberCount: z.number(),
  teamCount: z.number(),
});

export const OrganizationDtoSchema = OrganizationListItemDtoSchema.extend({
  logoUrl: z.string().nullable(),
  owners: z.array(OrganizationOwnerDtoSchema),
});

export const OrganizationListResultDtoSchema = z.object({
  items: z.array(OrganizationListItemDtoSchema),
  nextCursor: z.number().optional(),
});

export type OrganizationOwnerDto = z.infer<typeof OrganizationOwnerDtoSchema>;
export type OrganizationListItemDto = z.infer<typeof OrganizationListItemDtoSchema>;
export type OrganizationDto = z.infer<typeof OrganizationDtoSchema>;
export type OrganizationListResultDto = z.infer<typeof OrganizationListResultDtoSchema>;

export const OrganizationRoleDtoSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);

export type OrganizationRoleDto = z.infer<typeof OrganizationRoleDtoSchema>;

export const CurrentOrganizationDtoSchema = OrganizationDtoSchema.omit({
  memberCount: true,
  teamCount: true,
}).extend({ viewerRole: OrganizationRoleDtoSchema });

export const OrganizationMemberDtoSchema = z.object({
  userId: z.number(),
  name: z.string().nullable(),
  email: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  role: OrganizationRoleDtoSchema,
  accepted: z.boolean(),
});

export const OrganizationMemberListDtoSchema = z.object({
  items: z.array(OrganizationMemberDtoSchema),
  nextCursor: z.number().optional(),
});

export const OrganizationTeamDtoSchema = z.object({
  teamId: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
  memberCount: z.number(),
  viewerIsMember: z.boolean(),
});

export const OrganizationTeamListDtoSchema = z.object({
  items: z.array(OrganizationTeamDtoSchema),
  nextCursor: z.number().optional(),
});

export type CurrentOrganizationDto = z.infer<typeof CurrentOrganizationDtoSchema>;
export type OrganizationMemberDto = z.infer<typeof OrganizationMemberDtoSchema>;
export type OrganizationMemberListDto = z.infer<typeof OrganizationMemberListDtoSchema>;
export type OrganizationTeamDto = z.infer<typeof OrganizationTeamDtoSchema>;
export type OrganizationTeamListDto = z.infer<typeof OrganizationTeamListDtoSchema>;

export const RequestOrganizationDtoSchema = OrganizationListItemDtoSchema.pick({
  id: true,
  slug: true,
  domain: true,
  isDefault: true,
});

export type RequestOrganizationDto = z.infer<typeof RequestOrganizationDtoSchema>;
