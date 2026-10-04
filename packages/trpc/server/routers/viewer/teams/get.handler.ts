import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TGetTeamProfileInput } from "./teamProfile.schema";

type GetTeamProfileOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetTeamProfileInput;
};

export const getTeamProfileHandler = async ({ ctx, input }: GetTeamProfileOptions) => {
  const service = new TeamProfileService(prisma);
  return service.getTeamProfile({ teamId: input.teamId, userId: ctx.user.id });
};
