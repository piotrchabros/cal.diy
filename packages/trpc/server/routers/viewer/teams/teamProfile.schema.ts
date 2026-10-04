import { z } from "zod";

export const ZTeamSocialLinkSchema = z.object({
  platform: z.string().min(1).max(50),
  url: z.string().url().max(2048),
});

export type TTeamSocialLink = z.infer<typeof ZTeamSocialLinkSchema>;

export const ZTeamProfileMetadataSchema = z
  .object({
    location: z.string().max(255).optional(),
    showMap: z.boolean().optional(),
    socialLinks: z.array(ZTeamSocialLinkSchema).max(10).optional(),
  })
  .partial();

export type TTeamProfileMetadata = z.infer<typeof ZTeamProfileMetadataSchema>;

export const ZGetTeamProfileInputSchema = z.object({
  teamId: z.number().int().positive(),
});

export type TGetTeamProfileInput = z.infer<typeof ZGetTeamProfileInputSchema>;

export const TEAM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ZUpdateTeamProfileInputSchema = z.object({
  teamId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(100)
    .regex(TEAM_SLUG_PATTERN, "Slug may only contain lowercase letters, numbers and single dashes"),
  bio: z.string().max(2000).optional(),
  logoUrl: z.string().url().max(2048).nullable().optional(),
  location: z.string().trim().max(255).optional(),
  showMap: z.boolean().optional(),
  socialLinks: z.array(ZTeamSocialLinkSchema).max(10).optional(),
});

export type TUpdateTeamProfileInput = z.infer<typeof ZUpdateTeamProfileInputSchema>;

export const ZDisbandTeamInputSchema = z.object({
  teamId: z.number().int().positive(),
});

export type TDisbandTeamInput = z.infer<typeof ZDisbandTeamInputSchema>;
