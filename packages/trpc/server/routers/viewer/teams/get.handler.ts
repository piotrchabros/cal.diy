import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TTeamGetSchema } from "./get.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TTeamGetSchema;
};

export const getHandler = async ({ ctx, input }: GetOptions) => {
  const teamRepository = new TeamRepository();
  const team = await teamRepository.findBasicById({ teamId: input.teamId });
  if (!team) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Team ${input.teamId} not found` });
  }
  return team;
};
