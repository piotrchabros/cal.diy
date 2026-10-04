import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamResendInviteSchema } from "./resendInvite.schema";

type ResendInviteOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamResendInviteSchema;
};

export const resendInviteHandler = async ({ ctx, input }: ResendInviteOptions) => {
  const service = new TeamMembersService();
  return await service.resendInvite({
    teamId: input.teamId,
    requesterId: ctx.user.id,
    requesterName: ctx.user.name || ctx.user.email,
    email: input.email,
  });
};
