import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamAcceptInviteSchema } from "./acceptInvite.schema";

type AcceptInviteOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamAcceptInviteSchema;
};

export const acceptInviteHandler = async ({ ctx, input }: AcceptInviteOptions) => {
  const service = new TeamMembersService();
  return await service.acceptInvite({
    teamId: input.teamId,
    userId: ctx.user.id,
  });
};
