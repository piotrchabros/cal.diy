import { z } from "zod";

const id = z.number().int().positive();

export const ZListOrganizationsInput = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const ZGetOrganizationInput = z.object({ id });

export const ZOrganizationOwnerInput = z.object({ userId: id }).strict();

export const ZCreateOrganizationInput = z.object({
  name: z.string().max(100),
  slug: z.string().max(63),
  domain: z.string().max(253),
  owner: ZOrganizationOwnerInput,
  confirmMoveOwner: z.boolean().optional(),
});

export const ZUpdateOrganizationInput = z.object({
  id,
  name: z.string().max(100).optional(),
  slug: z.string().max(63).optional(),
  domain: z.string().max(253).optional(),
});

export const ZDeleteOrganizationInput = z.object({ id });

export const ZDeleteOrganizationOutput = z.object({ id });

export const ZMoveUserInput = z.object({
  userId: id,
  toOrganizationId: id,
  newUsername: z.string().trim().min(1).max(255).optional(),
});

export const ZPreviewMoveTeamInput = z.object({ teamId: id, toOrganizationId: id });

export const ZMoveTeamInput = z.object({
  teamId: id,
  toOrganizationId: id,
  newSlug: z.string().trim().min(1).max(50).optional(),
  outsideMembers: z.enum(["move", "remove"]),
});

export const ZListOrganizationTeamsInput = z.object({
  organizationId: id,
  search: z.string().trim().max(100).optional(),
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type TListOrganizationsInput = z.infer<typeof ZListOrganizationsInput>;
export type TGetOrganizationInput = z.infer<typeof ZGetOrganizationInput>;
export type TOrganizationOwnerInput = z.infer<typeof ZOrganizationOwnerInput>;
export type TCreateOrganizationInput = z.infer<typeof ZCreateOrganizationInput>;
export type TUpdateOrganizationInput = z.infer<typeof ZUpdateOrganizationInput>;
export type TDeleteOrganizationInput = z.infer<typeof ZDeleteOrganizationInput>;
export type TDeleteOrganizationOutput = z.infer<typeof ZDeleteOrganizationOutput>;
export type TMoveUserInput = z.infer<typeof ZMoveUserInput>;
export type TPreviewMoveTeamInput = z.infer<typeof ZPreviewMoveTeamInput>;
export type TMoveTeamInput = z.infer<typeof ZMoveTeamInput>;
export type TListOrganizationTeamsInput = z.infer<typeof ZListOrganizationTeamsInput>;
