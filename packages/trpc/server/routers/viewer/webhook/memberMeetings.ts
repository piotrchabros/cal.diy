import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { prisma } from "@calcom/prisma";
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

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { isOrganization: true },
  });

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
    teamId == null ? null : await MembershipRepository.getAdminOrOwnerMembership(userId, teamId);

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
    const isMember = await new MembershipRepository().hasMembership({ userId, teamId });
    if (!isMember) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
    }
  }

  await assertTeamAdminForMemberMeetings({ userId, teamId });
};
