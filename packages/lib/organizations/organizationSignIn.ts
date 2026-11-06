function withPath(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
}

export const WRONG_ORGANIZATION_DOMAIN_ERROR = "wrong_organization_domain";
export const SIGN_IN_REASON_PARAM = "reason";

// No `error` param on purpose: next-auth/react drops res.url when the URL carries ?error=,
// so the client could not follow the redirect to the organization's login page.
export function buildOrganizationLoginUrl(baseUrl: string): string {
  const url = withPath(baseUrl, "/auth/login");
  url.search = new URLSearchParams({ [SIGN_IN_REASON_PARAM]: WRONG_ORGANIZATION_DOMAIN_ERROR }).toString();
  return url.toString();
}

export function buildWrongOrganizationDomainErrorUrl(baseUrl: string): string {
  const url = withPath(baseUrl, "/auth/error");
  url.search = new URLSearchParams({ error: WRONG_ORGANIZATION_DOMAIN_ERROR }).toString();
  return url.toString();
}

export function isOrganizationLoginRedirect(url: string | null | undefined): url is string {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return (
    parsed.pathname === "/auth/login" &&
    parsed.searchParams.get(SIGN_IN_REASON_PARAM) === WRONG_ORGANIZATION_DOMAIN_ERROR
  );
}
