import { WEBAPP_URL } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import logger from "@calcom/lib/logger";
import { buildOrganizationOrigin } from "@calcom/lib/organizations/buildOrganizationOrigin";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";

const log = logger.getSubLogger({ prefix: ["getOrganizationOrigin"] });

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Returns the origin of `url` only when it is exactly an organization's configured domain, so callers
// can trust it as a redirect or sign-in link target. The URL must use the webapp's scheme and port, so
// org domains follow the deployment (https in production, http on a port locally); anything unusual is
// rejected before any lookup.
export async function getOrganizationOriginForUrl(url: string | null | undefined): Promise<string | null> {
  if (!isOrganizationsEnabled()) return null;
  if (!url) return null;

  const parsed = parseUrl(url);
  if (!parsed) return null;
  const webapp = parseUrl(WEBAPP_URL);
  if (!webapp) return null;
  if (parsed.protocol !== webapp.protocol || parsed.port !== webapp.port) return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname;
  if (!host || isLoopbackHost(host)) return null;

  try {
    const { getOrganizationDomainResolver } = await import("../di/OrganizationDomainResolver.container");
    const org = await getOrganizationDomainResolver().resolve(host);
    if (!org || normalizeHost(org.domain) !== host) return null;
    return buildOrganizationOrigin(host, WEBAPP_URL);
  } catch (error) {
    log.error("Failed to resolve organization for URL host", {
      host,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getSafeRedirectUrlForOrganizations(url?: string): Promise<string | null> {
  const origin = await getOrganizationOriginForUrl(url);
  return getSafeRedirectUrl(url, { allowedOrigins: origin ? [origin] : [] });
}
