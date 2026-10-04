import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamInviteMemberSchema } from "./inviteMember.schema";

type InviteMemberOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamInviteMemberSchema;
};

export const inviteMemberHandler = async ({ ctx, input }: InviteMemberOptions) => {
  const service = new TeamMembersService();
  return await service.inviteMember({
    teamId: input.teamId,
    requesterId: ctx.user.id,
    requesterName: ctx.user.name || ctx.user.email,
    email: input.email,
    role: input.role,
  });
};
