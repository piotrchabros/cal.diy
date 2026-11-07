import { requireDefaultOrganizationId } from "@calcom/features/organizations/lib/defaultOrganization";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

export type GetRequestHeaders = () => Pick<Headers, "get">;

export async function findNewUserOrganizationId(getRequestHeaders?: GetRequestHeaders): Promise<number> {
  if (isOrganizationsEnabled() && getRequestHeaders) {
    const { getOrgFromRequest } = await import("@calcom/features/organizations/lib/getOrgFromRequest");
    const org = await getOrgFromRequest(getRequestHeaders());
    if (org) return org.id;
  }
  return requireDefaultOrganizationId();
}
