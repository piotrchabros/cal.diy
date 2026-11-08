import { getEventTypeRepository } from "@calcom/features/eventtypes/di/EventTypeRepository.container";
import { getTeamRepository } from "@calcom/features/teams/di/TeamRepository.container";
import { getMembershipRepository } from "@calcom/features/users/di/MembershipRepository.container";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { TRPCError } from "@trpc/server";

export const assertMemberMeetingsScope = async ({
  teamId,
  platform,
  eventTypeId,
}: {
  teamId?: number | null;
  platform?: boolean | null;
  eventTypeId?: number | null;
}): Promise<number> => {
  if (teamId == null || platform || eventTypeId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "includeMemberMeetings is only available for team webhooks",
    });
  }

  const team = await getTeamRepository().findBasicById({ teamId });

  if (!team || team.isOrganization) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "includeMemberMeetings is not available for organizations",
    });
  }

  return teamId;
};

export const assertTeamAdminForMemberMeetings = async ({
  userId,
  teamId,
}: {
  userId: number;
  teamId: number | null;
}): Promise<void> => {
  const membership =
    teamId == null
      ? null
      : await getMembershipRepository().findAcceptedAdminOrOwnerByUserIdAndTeamId({ userId, teamId });

  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
};

export const assertCanManageTeamWebhooks = async ({
  userId,
  teamId,
}: {
  userId: number;
  teamId: number;
}): Promise<void> => {
  // FR-008: another organization's team must look nonexistent, not merely forbidden.
  if (isOrganizationsEnabled()) {
    const isMember = await getMembershipRepository().hasMembership({ userId, teamId });
    if (!isMember) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
    }
  }

  await assertTeamAdminForMemberMeetings({ userId, teamId });
};

export const assertCanManageEventTypeWebhooks = async ({
  userId,
  eventTypeId,
}: {
  userId: number;
  eventTypeId: number;
}): Promise<void> => {
  const eventType = await getEventTypeRepository().findByIdWithUserIdAndTeamId({ id: eventTypeId });

  if (!eventType) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  if (eventType.userId === userId) return;

  // Team event types have no owner (userId null) and their webhooks expose secrets, so only team admins may manage them.
  if (eventType.teamId != null) {
    await assertTeamAdminForMemberMeetings({ userId, teamId: eventType.teamId });
    return;
  }

  throw new TRPCError({ code: "FORBIDDEN" });
};
