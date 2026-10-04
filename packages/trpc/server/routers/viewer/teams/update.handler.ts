import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TUpdateTeamProfileInput } from "./teamProfile.schema";

type UpdateTeamProfileOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TUpdateTeamProfileInput;
};

export const updateTeamProfileHandler = async ({ ctx, input }: UpdateTeamProfileOptions) => {
  const service = new TeamProfileService(prisma);
  const { teamId, ...rest } = input;
  return service.updateTeamProfile({ teamId, userId: ctx.user.id, input: { teamId, ...rest } });
};
