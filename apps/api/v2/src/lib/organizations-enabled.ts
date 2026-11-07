import process from "node:process";

// Mirrors packages/lib/organizations/* because API v2 cannot import @calcom/lib directly (spec 005, T260).
export function isOrganizationsEnabled(): boolean {
  return process.env.ORGANIZATIONS_ENABLED === "1" || process.env.ORGANIZATIONS_ENABLED === "true";
}

// The BlueBee switch-over puts every user and team into one organization before the flag is turned on,
// so with organizations off a "no organization" filter would match nobody (spec 005, T221).
export function outsideOrganizationsFilter<T extends Record<string, unknown>>(filter: T): Partial<T> {
  return isOrganizationsEnabled() ? filter : {};
}

// Before the switch-over every team was top-level; afterwards they all sit under BlueBee (spec 005, T261)
export function topLevelTeamFilter(): { parentId: null } | { isOrganization: false } {
  return isOrganizationsEnabled() ? { parentId: null } : { isOrganization: false };
}
