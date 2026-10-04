import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamRemoveMemberSchema } from "./removeMember.schema";

type RemoveMemberOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamRemoveMemberSchema;
};

export const removeMemberHandler = async ({ ctx, input }: RemoveMemberOptions) => {
  const service = new TeamMembersService();
  return await service.removeMember({
    teamId: input.teamId,
    requesterId: ctx.user.id,
    userId: input.userId,
  });
};
