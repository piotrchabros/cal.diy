import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { convertErrorWithCodeToTRPCError } from "../../../lib/toTRPCError";
import type { TrpcSessionUser } from "../../../types";
import type { TTeamGetSchema } from "./get.schema";

type GetTeamOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamGetSchema;
};

export const getTeamHandler = async ({ ctx, input }: GetTeamOptions) => {
  const service = new TeamMembersService();
  try {
    return await service.getTeam({
      teamId: input.teamId,
      viewerId: ctx.user.id,
    });
  } catch (error) {
    throw convertErrorWithCodeToTRPCError(error);
  }
};
