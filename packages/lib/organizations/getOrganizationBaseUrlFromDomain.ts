import { WEBAPP_URL } from "@calcom/lib/constants";
import { buildOrganizationOrigin } from "@calcom/lib/organizations/buildOrganizationOrigin";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";

export function getDefaultOrganizationDomain(webappUrl: string = WEBAPP_URL): string | null {
  return normalizeHost(new URL(webappUrl).host);
}

export function getOrganizationBaseUrlFromDomain(
  domain: string | null | undefined,
  defaultDomain: string | null
): string {
  const normalizedDomain = normalizeHost(domain);
  // The default org and loopback domains are served from WEBAPP_URL itself, which already carries
  // the configured base URL including any path, so a rebuilt origin would drop that path.
  if (!normalizedDomain || normalizedDomain === defaultDomain || isLoopbackHost(normalizedDomain)) {
    return WEBAPP_URL;
  }
  return buildOrganizationOrigin(normalizedDomain);
}
