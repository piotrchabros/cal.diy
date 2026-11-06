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

export const RequestOrganizationDtoSchema = OrganizationListItemDtoSchema.pick({
  id: true,
  slug: true,
  domain: true,
  isDefault: true,
});

export type RequestOrganizationDto = z.infer<typeof RequestOrganizationDtoSchema>;
