import { MembershipRole } from "@calcom/prisma/enums";

export interface TeamPermissions {
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRead: boolean;
}

export interface MembershipWithRole {
  teamId: number;
  membershipRole: MembershipRole;
}

const MEMBERSHIP_HIERARCHY: Record<MembershipRole, number> = {
  [MembershipRole.MEMBER]: 1,
  [MembershipRole.ADMIN]: 2,
  [MembershipRole.OWNER]: 3,
};

export function hasHigherPrivilege(role1: MembershipRole, role2: MembershipRole): boolean {
  return MEMBERSHIP_HIERARCHY[role1] > MEMBERSHIP_HIERARCHY[role2];
}

export function getEffectiveRole(
  orgMembership: MembershipRole | undefined,
  membershipRole: MembershipRole
): MembershipRole {
  return orgMembership && hasHigherPrivilege(orgMembership, membershipRole) ? orgMembership : membershipRole;
}

const MANAGE_ROLES: readonly MembershipRole[] = [MembershipRole.ADMIN, MembershipRole.OWNER];
const READ_ROLES: readonly MembershipRole[] = [
  MembershipRole.ADMIN,
  MembershipRole.OWNER,
  MembershipRole.MEMBER,
];

// Only an accepted ADMIN/OWNER may create, edit or delete a team's event types; an accepted MEMBER
// may read them. This mirrors hasTeamEventRole (teamEventVisibility.ts): the memberships handed to
// buildTeamPermissionsMap are already limited to the caller's accepted memberships (EventGroupBuilder
// queries with accepted: true and TeamAccessUseCase drops the rest), so checking the effective role
// is a check against accepted membership — unlike the previous always-true stub.
export function getTeamPermissions(effectiveRole: MembershipRole): TeamPermissions {
  const canManage = MANAGE_ROLES.includes(effectiveRole);

  return {
    canCreate: canManage,
    canEdit: canManage,
    canDelete: canManage,
    canRead: READ_ROLES.includes(effectiveRole),
  };
}

export function buildTeamPermissionsMap(
  memberships: Array<{ team: { id: number; parentId?: number | null }; role: MembershipRole }>,
  teamMemberships: MembershipWithRole[]
): Map<number, TeamPermissions> {
  return new Map(
    memberships.map((membership) => {
      const orgMembership = teamMemberships.find(
        (teamM) => teamM.teamId === membership.team.parentId
      )?.membershipRole;

      const effectiveRole = getEffectiveRole(orgMembership, membership.role);
      return [membership.team.id, getTeamPermissions(effectiveRole)] as const;
    })
  );
}
