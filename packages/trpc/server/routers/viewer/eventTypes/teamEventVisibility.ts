import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";

export const teamVisibilitySelect = (userId: number) =>
  ({
    parent: {
      select: {
        members: {
          where: {
            userId,
            accepted: true,
            role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
          },
          select: { userId: true },
        },
      },
    },
  }) satisfies Prisma.TeamSelect;

export type TeamVisibilitySource = {
  members: { userId: number; accepted: boolean }[];
  parent: { members: { userId: number }[] } | null;
};

export type TeamRoleSource = {
  members: { userId: number; accepted: boolean; role: MembershipRole }[];
  parent: { members: { userId: number }[] } | null;
};

export function hasTeamEventRole(
  team: TeamRoleSource,
  userId: number,
  allowedRoles: readonly MembershipRole[]
): boolean {
  const hasTeamRole = team.members.some(
    (member) => member.userId === userId && member.accepted && allowedRoles.includes(member.role)
  );
  if (hasTeamRole) return true;
  // Admins and owners of the parent organization manage every team event in it.
  return team.parent?.members.some((member) => member.userId === userId) ?? false;
}

export function assertTeamEventVisible(team: TeamVisibilitySource, userId: number): void {
  if (!isOrganizationsEnabled()) return;
  if (team.members.some((member) => member.userId === userId && member.accepted)) return;
  if (team.parent && team.parent.members.length > 0) return;
  // FR-008: with organizations on, a team event the caller cannot see must look nonexistent so
  // another organization's event type ids cannot be probed.
  throw new TRPCError({ code: "NOT_FOUND" });
}
