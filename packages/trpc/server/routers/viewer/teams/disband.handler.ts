import { getTeamProfileService } from "@calcom/features/teams/di/TeamProfileService.container";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TDisbandTeamInput } from "./teamProfile.schema";

type DisbandTeamOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDisbandTeamInput;
};

export const disbandTeamHandler = async ({ ctx, input }: DisbandTeamOptions) => {
  const service = getTeamProfileService();
  return service.disbandTeam({ teamId: input.teamId, userId: ctx.user.id });
};
