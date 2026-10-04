import {
  TEAM_BIO_MAX_LENGTH,
  TEAM_LOGO_URL_MAX_LENGTH,
  TEAM_NAME_MAX_LENGTH,
  TEAM_SLUG_MAX_LENGTH,
} from "@calcom/features/teams/services/TeamCreationService";
import { z } from "zod";

export const ZCreateInputSchema = z.object({
  name: z.string().min(1).max(TEAM_NAME_MAX_LENGTH),
  slug: z.string().min(1).max(TEAM_SLUG_MAX_LENGTH),
  bio: z.string().max(TEAM_BIO_MAX_LENGTH).optional(),
  logoUrl: z.string().max(TEAM_LOGO_URL_MAX_LENGTH).optional().nullable(),
});

export type TCreateInputSchema = z.infer<typeof ZCreateInputSchema>;
