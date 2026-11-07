import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { MembershipRole } from "@calcom/prisma/enums";

// Admins and owners of a parent organization manage every team in it, whatever role the team requires.
// With organizations off every team still sits under BlueBee after the switch-over, so its admins must
// not administer all teams (spec 005).
function parentOrganizationRoles(): MembershipRole[] {
  return isOrganizationsEnabled() ? [MembershipRole.ADMIN, MembershipRole.OWNER] : [];
}

export type TeamRolePermissionInput = {
  userId: number;
  /**
   * The permission the caller models (e.g. "booking.readTeamBookings"). cal.diy has no PBAC, so only
   * `fallbackRoles` decide; the name stays at call sites to document intent.
   */
  permission?: string;
  fallbackRoles: readonly MembershipRole[];
};

/**
 * Replaces the always-true PermissionCheckService stubs left behind when PBAC was removed:
 * a user holds a permission on a team when they have an accepted membership in that team with one of
 * `fallbackRoles`, or (organizations on) an accepted ADMIN/OWNER membership in the team's parent organization.
 */
export class TeamRolePermissionService {
  constructor(private readonly membershipRepository: MembershipRepository = new MembershipRepository()) {}

  async checkPermission({ userId, teamId, fallbackRoles }: TeamRolePermissionInput & { teamId: number }) {
    const teamIds = await this.membershipRepository.findTeamIdsByAcceptedRole({
      userId,
      teamId,
      teamRoles: fallbackRoles,
      parentRoles: parentOrganizationRoles(),
    });
    return teamIds.length > 0;
  }

  async getTeamIdsWithPermission({ userId, fallbackRoles }: TeamRolePermissionInput): Promise<number[]> {
    return this.membershipRepository.findTeamIdsByAcceptedRole({
      userId,
      teamRoles: fallbackRoles,
      parentRoles: parentOrganizationRoles(),
      // With organizations off the BlueBee organization every user belongs to must not count as a team,
      // or its admins would reach every user through it.
      includeOrganizations: isOrganizationsEnabled(),
    });
  }
}
