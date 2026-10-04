import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamGetSchema } from "./get.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamGetSchema;
};

export const getHandler = async ({ ctx, input }: GetOptions) => {
  const service = new TeamMembersService();
  return await service.getTeam({
    teamId: input.teamId,
    viewerId: ctx.user.id,
  });
};
