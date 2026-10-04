import { TeamCreationService } from "@calcom/features/teams/services/TeamCreationService";

import type { TIsSlugAvailableInputSchema } from "./isSlugAvailable.schema";

type IsSlugAvailableHandlerOptions = {
  input: TIsSlugAvailableInputSchema;
};

export const isSlugAvailableHandler = async ({ input }: IsSlugAvailableHandlerOptions) => {
  const normalizedSlug = TeamCreationService.normalizeSlug(input.slug);
  const available = await TeamCreationService.isSlugAvailable(input.slug);
  return { available, slug: normalizedSlug };
};
