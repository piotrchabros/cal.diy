import { TEAM_SLUG_MAX_LENGTH } from "@calcom/features/teams/services/TeamCreationService";
import { z } from "zod";

export const ZIsSlugAvailableInputSchema = z.object({
  slug: z.string().min(1).max(TEAM_SLUG_MAX_LENGTH),
});

export type TIsSlugAvailableInputSchema = z.infer<typeof ZIsSlugAvailableInputSchema>;
