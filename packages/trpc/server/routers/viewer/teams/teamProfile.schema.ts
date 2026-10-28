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

export const TEAM_LOGO_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|svg\+xml);base64,/i;

// The uploader accepts files up to 5 MB, which grow by a third once base64-encoded.
const MAX_TEAM_LOGO_DATA_URL_LENGTH = 8_000_000;

export const ZTeamLogoUrlSchema = z.union([
  z
    .string()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value)),
  z.string().regex(/^\/api\/avatar\/[\w-]+\.png$/),
  z.string().max(MAX_TEAM_LOGO_DATA_URL_LENGTH).regex(TEAM_LOGO_DATA_URL_PATTERN),
]);

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
  logoUrl: ZTeamLogoUrlSchema.nullable().optional(),
  location: z.string().trim().max(255).optional(),
  showMap: z.boolean().optional(),
  socialLinks: z.array(ZTeamSocialLinkSchema).max(10).optional(),
});

export type TUpdateTeamProfileInput = z.infer<typeof ZUpdateTeamProfileInputSchema>;

export const ZDisbandTeamInputSchema = z.object({
  teamId: z.number().int().positive(),
});

export type TDisbandTeamInput = z.infer<typeof ZDisbandTeamInputSchema>;
