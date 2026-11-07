import { isOrganizationsEnabled } from "./isOrganizationsEnabled";

// The BlueBee switch-over puts every user and team into one organization before the flag is turned on,
// so with organizations off a "no organization" filter would match nobody (spec 005, T221).
export function outsideOrganizationsFilter<T extends Record<string, unknown>>(filter: T): Partial<T> {
  return isOrganizationsEnabled() ? filter : {};
}
