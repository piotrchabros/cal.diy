import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

// The BlueBee switch-over gives every team a parent before the flag is turned on, so with organizations
// off a parentId no longer means an organization team and must not unlock org-only behaviour (spec 005).
export function isOrganizationTeam(team: { parentId: number | null } | null | undefined): boolean {
  return isOrganizationsEnabled() && !!team?.parentId;
}
