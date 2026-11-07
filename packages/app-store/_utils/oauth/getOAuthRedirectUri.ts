import { ALLOWED_HOSTNAMES, WEBAPP_URL, WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { SafeRedirectOptions } from "@calcom/lib/getSafeRedirectUrl";
import logger from "@calcom/lib/logger";
import { buildOrganizationOrigin } from "@calcom/lib/organizations/buildOrganizationOrigin";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";

const log = logger.getSubLogger({ prefix: ["getOAuthRedirectUri"] });

function getHostOfUrl(url: string): string | null {
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return null;
  }
}

function getCandidateOrganizationHost(req: OAuthRequest): string | null {
  if (!isOrganizationsEnabled()) return null;
  if (typeof req.headers.host !== "string") return null;

  const host = normalizeHost(req.headers.host);
  if (!host || isLoopbackHost(host)) return null;
  if (host === getHostOfUrl(WEBAPP_URL_FOR_OAUTH) || host === getHostOfUrl(WEBAPP_URL)) return null;

  return host;
}

function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowedHost) => normalizeHost(allowedHost) === host);
}

function getTrustedOrganizationHost(req: OAuthRequest, allowedHosts: readonly string[]): string | null {
  const host = getCandidateOrganizationHost(req);
  if (!host || !isAllowedHost(host, allowedHosts)) return null;
  return host;
}

export type OAuthRequest = { headers: { host?: string | string[] } };

export function getOAuthAllowedOrigins(
  req: OAuthRequest,
  allowedHosts: readonly string[] = ALLOWED_HOSTNAMES
): string[] {
  const host = getTrustedOrganizationHost(req, allowedHosts);
  return host ? [buildOrganizationOrigin(host, WEBAPP_URL)] : [];
}

export function getOAuthAppOrigin(
  req: OAuthRequest,
  allowedHosts: readonly string[] = ALLOWED_HOSTNAMES
): string {
  return getOAuthAllowedOrigins(req, allowedHosts)[0] ?? WEBAPP_URL;
}

export function getOAuthSafeRedirectOptions(
  req: OAuthRequest,
  allowedHosts: readonly string[] = ALLOWED_HOSTNAMES
): Required<SafeRedirectOptions> {
  const allowedOrigins = getOAuthAllowedOrigins(req, allowedHosts);
  return { allowedOrigins, fallbackUrl: `${allowedOrigins[0] ?? WEBAPP_URL}/` };
}

export function getOAuthRedirectUri(
  req: OAuthRequest,
  appSlug: string,
  allowedHosts: readonly string[] = ALLOWED_HOSTNAMES
): string {
  const defaultRedirectUri = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/${appSlug}/callback`;
  const host = getCandidateOrganizationHost(req);
  if (!host) return defaultRedirectUri;

  if (!isAllowedHost(host, allowedHosts)) {
    log.warn("Refusing OAuth callback on a host that is not in ALLOWED_HOSTNAMES", { host, appSlug });
    return defaultRedirectUri;
  }

  // The callback must stay on the domain the user signed in on, because decodeOAuthState
  // checks the state nonce against that domain's session cookie.
  return `${buildOrganizationOrigin(host, WEBAPP_URL)}/api/integrations/${appSlug}/callback`;
}
