import { getTeamProfileService } from "@calcom/features/teams/di/TeamProfileService.container";
import { convertErrorWithCodeToTRPCError } from "@calcom/trpc/server/lib/toTRPCError";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetTeamProfileInput } from "./teamProfile.schema";

type GetTeamProfileOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetTeamProfileInput;
};

export const getTeamProfileHandler = async ({ ctx, input }: GetTeamProfileOptions) => {
  const service = getTeamProfileService();
  try {
    return await service.getTeamProfile({ teamId: input.teamId, userId: ctx.user.id });
  } catch (error) {
    throw convertErrorWithCodeToTRPCError(error);
  }
};
