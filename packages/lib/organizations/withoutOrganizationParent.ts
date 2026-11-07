import { isOrganizationsEnabled } from "./isOrganizationsEnabled";

// The BlueBee switch-over gives every team the organization as parent before the flag is turned on,
// so with organizations off teams must keep looking top-level as they did before (spec 005, T262).
export function withoutOrganizationParent<T extends { parentId: number | null; parent?: unknown }>(
  team: T
): Omit<T, "parentId" | "parent"> & { parentId: number | null; parent: T["parent"] | null } {
  if (isOrganizationsEnabled()) return { ...team, parent: team.parent ?? null };
  return { ...team, parentId: null, parent: null };
}
