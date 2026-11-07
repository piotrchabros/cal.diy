import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { getOrgFromRequest } from "./getOrgFromRequest";
import { DEFAULT_ORG_BASE_URL_CONTEXT, type OrgBaseUrlContextValue } from "./orgBaseUrlDefaults";

const log = logger.getSubLogger({ prefix: ["getRequestOrgBaseUrl"] });

export async function getRequestOrgBaseUrl(headers: Pick<Headers, "get">): Promise<OrgBaseUrlContextValue> {
  // No domain lookup or Prisma load while the feature is off.
  if (!isOrganizationsEnabled()) return DEFAULT_ORG_BASE_URL_CONTEXT;

  let organizationId: number | undefined;
  try {
    const org = await getOrgFromRequest(headers);
    if (!org) return DEFAULT_ORG_BASE_URL_CONTEXT;
    organizationId = org.id;

    const { getOrganizationUrlService } = await import("../di/OrganizationUrlService.container");
    const baseUrl = await getOrganizationUrlService().getBaseUrl({ organizationId: org.id });
    return { baseUrl, orgSlug: org.slug };
  } catch (error) {
    // The root layout runs on every page, so a lookup failure must fall back rather than 500 the site.
    log.error("Failed to resolve organization base URL", {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_ORG_BASE_URL_CONTEXT;
  }
}
