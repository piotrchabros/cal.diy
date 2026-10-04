import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";

type MyTeamsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const myTeamsHandler = async ({ ctx }: MyTeamsOptions) => {
  const service = new TeamMembersService();
  return await service.listMyTeams({ userId: ctx.user.id });
};
