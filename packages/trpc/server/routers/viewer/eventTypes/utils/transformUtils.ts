import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import { getPlaceholderAvatar } from "@calcom/lib/defaultAvatarImage";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { getTeamOrganizationId } from "@calcom/lib/organizations/getTeamOrganizationId";
import type { MembershipRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";
import type { TeamPermissions } from "./permissionUtils";

export interface EventTypeGroup {
  teamId?: number | null;
  parentId?: number | null;
  bookerUrl: string;
  membershipRole?: MembershipRole | null;
  profile: {
    slug: string | null;
    name: string | null;
    image: string;
    eventTypesLockedByOrg?: boolean;
  };
  metadata: {
    membershipCount: number;
    readOnly: boolean;
  };
}

export interface ProfileWithPermissions {
  slug: string | null;
  name: string | null;
  image: string;
  eventTypesLockedByOrg?: boolean;
  membershipCount: number;
  readOnly: boolean;
  teamId?: number | null;
  membershipRole?: MembershipRole | null;
  canCreateEventTypes?: boolean;
  canUpdateEventTypes?: boolean;
  canDeleteEventTypes?: boolean;
}

export async function createUserEventGroup(
  profile: {
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    organizationId: number | null;
  },
  parentOrgHasLockedEventTypes: boolean
): Promise<EventTypeGroup> {
  const bookerUrl = await getOrganizationUrlService().getBaseUrl({
    organizationId: profile.organizationId ?? null,
  });

  return {
    teamId: null,
    bookerUrl,
    membershipRole: null,
    profile: {
      slug: profile.username,
      name: profile.name,
      image: getUserAvatarUrl({
        avatarUrl: profile.avatarUrl,
      }),
      eventTypesLockedByOrg: parentOrgHasLockedEventTypes,
    },
    metadata: {
      membershipCount: 1,
      readOnly: false,
    },
  };
}

export async function createTeamEventGroup(
  membership: {
    team: {
      id: number;
      name: string;
      slug: string | null;
      logoUrl: string | null;
      parentId: number | null;
      isOrganization: boolean;
      parent?: {
        name: string;
        slug: string | null;
        logoUrl: string | null;
        metadata: unknown;
      } | null;
      metadata: unknown;
    };
    role: MembershipRole;
  },
  effectiveRole: MembershipRole,
  teamSlug: string | null,
  permissions: TeamPermissions
): Promise<EventTypeGroup> {
  const team = {
    ...membership.team,
    metadata: teamMetadataSchema.parse(membership.team.metadata),
  };

  return {
    teamId: team.id,
    parentId: team.parentId,
    bookerUrl: await getOrganizationUrlService().getBaseUrl({ organizationId: getTeamOrganizationId(team) }),
    membershipRole: effectiveRole,
    profile: {
      image: team.parent
        ? getPlaceholderAvatar(team.parent.logoUrl, team.parent.name)
        : getPlaceholderAvatar(team.logoUrl, team.name),
      name: team.name,
      slug: teamSlug,
    },
    metadata: {
      membershipCount: 0,
      readOnly: !permissions.canEdit,
    },
  };
}

export function createProfilesWithPermissions(
  eventTypeGroups: EventTypeGroup[],
  teamPermissionsMap: Map<number, TeamPermissions>
): ProfileWithPermissions[] {
  return eventTypeGroups.map((group) => {
    let canCreateEventTypes: boolean | undefined;
    let canUpdateEventTypes: boolean | undefined;
    let canDeleteEventTypes: boolean | undefined;

    if (group.teamId) {
      const permissions = teamPermissionsMap.get(group.teamId);
      canCreateEventTypes = permissions?.canCreate;
      canUpdateEventTypes = permissions?.canEdit;
      canDeleteEventTypes = permissions?.canDelete;
    }

    return {
      ...group.profile,
      ...group.metadata,
      teamId: group.teamId,
      membershipRole: group.membershipRole,
      canCreateEventTypes,
      canUpdateEventTypes,
      canDeleteEventTypes,
    };
  });
}
