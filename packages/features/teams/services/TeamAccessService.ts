import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { MembershipRole } from "@calcom/prisma/enums";

export interface ITeamAccessServiceDeps {
  membershipRepo: Pick<MembershipRepository, "findUniqueByUserIdAndTeamId">;
  teamRepo: Pick<TeamRepository, "findBasicById">;
}

const ORGANIZATION_ADMIN_ROLES: readonly MembershipRole[] = [MembershipRole.ADMIN, MembershipRole.OWNER];

export class TeamAccessService {
  constructor(private readonly deps: ITeamAccessServiceDeps) {}

  // Accepted team members see the team; so do admins and owners of its parent organization,
  // who manage every team in it. Pending invitees have not joined yet.
  async canViewTeam({ userId, teamId }: { userId: number; teamId: number }): Promise<boolean> {
    const membership = await this.deps.membershipRepo.findUniqueByUserIdAndTeamId({ userId, teamId });
    if (membership?.accepted) return true;

    const team = await this.deps.teamRepo.findBasicById({ teamId });
    if (!team?.parentId) return false;

    const organizationMembership = await this.deps.membershipRepo.findUniqueByUserIdAndTeamId({
      userId,
      teamId: team.parentId,
    });
    return (
      !!organizationMembership?.accepted && ORGANIZATION_ADMIN_ROLES.includes(organizationMembership.role)
    );
  }
}
