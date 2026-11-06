import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { UsernameNamespace } from "@calcom/lib/server/username";

export function resolveUsernameNamespace(params: {
  organizationId: number | null | undefined;
  legacyOrgSlug?: string | null;
}): UsernameNamespace {
  if (isOrganizationsEnabled()) {
    return params.organizationId ? { organizationId: params.organizationId } : null;
  }
  // With ORGANIZATIONS_ENABLED off, keep the pre-existing slug-based lookup so behaviour is unchanged.
  return params.legacyOrgSlug ? { orgSlug: params.legacyOrgSlug } : null;
}
