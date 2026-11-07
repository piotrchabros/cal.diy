import { isOrganizationsEnabled } from "./isOrganizationsEnabled";

// Before the switch-over every team was top-level; afterwards they all sit under BlueBee (spec 005, T261)
export function topLevelTeamFilter(): { parentId: null } | { isOrganization: false } {
  return isOrganizationsEnabled() ? { parentId: null } : { isOrganization: false };
}
