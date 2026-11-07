import { findUsersForAvailabilityCheck } from "@calcom/features/availability/lib/findUsersForAvailabilityCheck";
import { getUserAvailabilityService } from "@calcom/features/di/containers/GetUserAvailability";
import { TRPCError } from "@trpc/server";
import type { TrpcSessionUser } from "../../../types";
import type { TUserInputSchema } from "./user.schema";

type UserOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TUserInputSchema;
};

function getUser(sessionUser: UserOptions["ctx"]["user"], username: string) {
  if (username === sessionUser.username) {
    return findUsersForAvailabilityCheck({ where: { id: sessionUser.id } });
  }
  // FR-008: usernames repeat across organizations, so another organization's user must look nonexistent.
  const { organizationId } = sessionUser;
  if (organizationId == null) return null;
  return findUsersForAvailabilityCheck({ where: { username, organizationId } });
}

export const userHandler = async ({ ctx, input }: UserOptions) => {
  const userAvailabilityService = getUserAvailabilityService();
  const user = await getUser(ctx.user, input.username);
  if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  return userAvailabilityService.getUserAvailabilityIncludingBusyTimesFromLimits(
    { returnDateOverrides: true, bypassBusyCalendarTimes: false, ...input },
    {
      user,
    }
  );
};
