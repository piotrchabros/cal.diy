import { TeamCreationService } from "@calcom/features/teams/services/TeamCreationService";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { TrpcSessionUser } from "../../../types";
import type { TIsSlugAvailableInputSchema } from "./isSlugAvailable.schema";

type IsSlugAvailableHandlerOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "organizationId">;
  };
  input: TIsSlugAvailableInputSchema;
};

export const isSlugAvailableHandler = async ({ ctx, input }: IsSlugAvailableHandlerOptions) => {
  const organizationId = isOrganizationsEnabled() ? (ctx.user.organizationId ?? null) : null;
  const normalizedSlug = TeamCreationService.normalizeSlug(input.slug);
  const available = await TeamCreationService.isSlugAvailable(input.slug, organizationId);
  return { available, slug: normalizedSlug };
};
