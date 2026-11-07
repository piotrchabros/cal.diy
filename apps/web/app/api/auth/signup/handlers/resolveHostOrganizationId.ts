import { requireDefaultOrganizationId } from "@calcom/features/organizations/lib/defaultOrganization";
import { getOrgFromRequest } from "@calcom/features/organizations/lib/getOrgFromRequest";

// Users join the org of the domain they signed up on; with organizations off that is always the default org
export async function resolveHostOrganizationId(
  orgsEnabled: boolean,
  requestHeaders: Pick<Headers, "get">
): Promise<number | null> {
  if (!orgsEnabled) return requireDefaultOrganizationId();
  return (await getOrgFromRequest(requestHeaders))?.id ?? null;
}
