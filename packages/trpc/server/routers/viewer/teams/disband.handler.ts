import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TDisbandTeamInput } from "./teamProfile.schema";

type DisbandTeamOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDisbandTeamInput;
};

export const disbandTeamHandler = async ({ ctx, input }: DisbandTeamOptions) => {
  const service = new TeamProfileService(prisma);
  return service.disbandTeam({ teamId: input.teamId, userId: ctx.user.id });
};
