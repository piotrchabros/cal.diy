import { getLocationGroupedOptions } from "@calcom/app-store/server";
import { getTeamAccessService } from "@calcom/features/teams/di/TeamAccessService.container";
import { getTranslation } from "@calcom/i18n/server";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import type { TLocationOptionsInputSchema } from "./locationOptions.schema";

type LocationOptionsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TLocationOptionsInputSchema;
};

export const locationOptionsHandler = async ({ ctx, input }: LocationOptionsOptions) => {
  const { teamId } = input;

  // FR-008: another organization's team, and the conferencing apps installed on it or its
  // organization, must look nonexistent.
  if (
    teamId &&
    isOrganizationsEnabled() &&
    !(await getTeamAccessService().canViewTeam({ userId: ctx.user.id, teamId }))
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
  }

  const t = await getTranslation(ctx.user.locale ?? "en", "common");

  const locationOptions = await getLocationGroupedOptions(teamId ? { teamId } : { userId: ctx.user.id }, t);
  // If it is a team event then move the "use host location" option to top
  if (input.teamId) {
    const conferencingIndex = locationOptions.findIndex((option) => option.label === "Conferencing");
    if (conferencingIndex !== -1) {
      const conferencingObject = locationOptions.splice(conferencingIndex, 1)[0];
      locationOptions.unshift(conferencingObject);
    }
  }

  return locationOptions;
};
