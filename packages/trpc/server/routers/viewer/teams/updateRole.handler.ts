import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamUpdateRoleSchema } from "./updateRole.schema";

type UpdateRoleOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamUpdateRoleSchema;
};

export const updateRoleHandler = async ({ ctx, input }: UpdateRoleOptions) => {
  const service = new TeamMembersService();
  return await service.updateMemberRole({
    teamId: input.teamId,
    requesterId: ctx.user.id,
    userId: input.userId,
    role: input.role,
  });
};
