import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamListMembersSchema } from "./listMembers.schema";

type ListMembersOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamListMembersSchema;
};

export const listMembersHandler = async ({ ctx, input }: ListMembersOptions) => {
  const service = new TeamMembersService();
  return await service.listMembers({
    teamId: input.teamId,
    viewerId: ctx.user.id,
    search: input.search,
    roles: input.roles,
    accepted: input.accepted,
    page: input.page,
    pageSize: input.pageSize,
  });
};
