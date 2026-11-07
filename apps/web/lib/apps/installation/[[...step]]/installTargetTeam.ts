import { getPlaceholderAvatar } from "@calcom/lib/defaultAvatarImage";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

type InstallTargetTeamInput = {
  name: string;
  logoUrl: string | null;
  parent: { name: string; logoUrl: string | null } | null;
};

export function toInstallTargetTeam<T extends InstallTargetTeamInput>(team: T) {
  // With organizations off every team sits under BlueBee, which must not surface as their parent (spec 005, T322)
  const parent = isOrganizationsEnabled() ? team.parent : null;
  const logoUrl = parent
    ? getPlaceholderAvatar(parent.logoUrl, parent.name)
    : getPlaceholderAvatar(team.logoUrl, team.name);
  return { ...team, parent, logoUrl };
}
