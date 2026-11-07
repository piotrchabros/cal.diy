import process from "node:process";
import type { ParsedUrlQuery } from "node:querystring";
import { setOrgHeaders, stripOrgHeaders } from "@calcom/features/organizations/lib/orgRequestHeaders";
import { WEBAPP_URL } from "@calcom/lib/constants";
import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import slugify from "@calcom/lib/slugify";
import { RedirectType } from "@calcom/prisma/enums";
import { getCspHeader, getCspNonce } from "@lib/csp";
import { get } from "@vercel/edge-config";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const safeGet = async <T = any>(key: string): Promise<T | undefined> => {
  try {
    return get<T>(key);
  } catch (error) {
    // Don't crash if EDGE_CONFIG env var is missing
  }
};

// Vercel/Edge rejects non‑ASCII header values (see: https://github.com/vercel/next.js/issues/85631)
const isAscii = (s: string) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
const stripNonAscii = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) <= 0x7f) out += s[i];
  return out;
};
const sanitizeRequestHeaders = (headers: Iterable<[string, string]>): Headers => {
  const out = new Headers();
  for (const [name, raw] of Array.from(headers)) {
    if (!isAscii(name)) continue;
    let value = raw;
    if (!isAscii(value)) {
      // Heuristic: if the string contains common mojibake markers (Ã: 0xC3, Â: 0xC2),
      // prefer a simple strip (avoids introducing spurious ASCII letters like 'A').
      let hasMojibakeMarker = false;
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 0xc3 || code === 0xc2) {
          hasMojibakeMarker = true;
          break;
        }
      }

      if (hasMojibakeMarker) {
        value = stripNonAscii(value);
      } else {
        try {
          value = stripNonAscii(value.normalize("NFKD"));
        } catch {
          value = stripNonAscii(value);
        }
      }
    }
    if (value) out.set(name, value);
  }
  return out;
};

const isPagePathRequest = (url: URL) => {
  const isNonPagePathPrefix = /^\/(?:_next|api)\//;
  const isFile = /\..*$/;
  const { pathname } = url;
  return !isNonPagePathPrefix.test(pathname) && !isFile.test(pathname);
};

const shouldEnforceCsp = (url: URL) => {
  return url.pathname.startsWith("/auth/login") || url.pathname.startsWith("/login");
};

const LEGACY_PROXY_ROUTES: ReadonlySet<string> = new Set([
  "/auth/login",
  "/login",
  "/apps/installed",
  "/auth/logout",
  "/availability",
  "/api/auth/signup",
]);

// Routes the proxy used to be limited to; only they get the CSP, embed, return-to and logout handling.
const isLegacyProxyRoute = (pathname: string): boolean => {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return LEGACY_PROXY_ROUTES.has(path) || path.endsWith("/embed");
};

const defaultHost: string | null = normalizeHost(new URL(WEBAPP_URL).host);

// Loopback (health check, local dev) and the WEBAPP_URL host must keep working even when no
// organization matches them or the lookup fails.
const isTrustedFallbackHost = (host: string | null): boolean =>
  isLoopbackHost(host) || (defaultHost !== null && normalizeHost(host) === defaultHost);

type OrganizationResolution =
  | { kind: "ok"; org: RequestOrganizationDto | null }
  | { kind: "unknown-host" }
  | { kind: "error" };

const resolveRequestOrganization = async (host: string | null): Promise<OrganizationResolution> => {
  if (!isOrganizationsEnabled()) return { kind: "ok", org: null };

  try {
    // Loaded lazily so that with organizations disabled the proxy never pulls in Prisma.
    const { getOrganizationDomainResolver } = await import(
      "@calcom/features/organizations/di/OrganizationDomainResolver.container"
    );
    const org = await getOrganizationDomainResolver().resolve(host);
    if (org) return { kind: "ok", org };
    return isTrustedFallbackHost(host) ? { kind: "ok", org: null } : { kind: "unknown-host" };
  } catch (error) {
    console.error("proxy: organization lookup failed", {
      host: normalizeHost(host),
      error: error instanceof Error ? error.name : "unknown",
    });
    return isTrustedFallbackHost(host) ? { kind: "ok", org: null } : { kind: "error" };
  }
};

const applyOrgHeaders = (headers: Headers, org: RequestOrganizationDto | null): void => {
  stripOrgHeaders(headers);
  if (org) setOrgHeaders(headers, org);
};

const TEAM_PAGE_PATH = /^\/team\/([^/]+)(?:\/([^/]+))?\/?$/;

const safeDecode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const toParsedUrlQuery = (searchParams: URLSearchParams): ParsedUrlQuery => {
  const query: ParsedUrlQuery = {};
  for (const [key, value] of Array.from(searchParams.entries())) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return query;
};

// The team pages stream (team/[slug]/loading.tsx), so their own permanentRedirect() only fires after a
// 200 has been sent and the move happens client-side; answering here gives old links a real 308.
const getMovedTeamRedirect = async (req: NextRequest, hostOrgId: number): Promise<string | null> => {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const match = TEAM_PAGE_PATH.exec(req.nextUrl.pathname);
  if (!match) return null;
  const [, rawSlug, rawType] = match;
  if (rawType === "embed") return null;

  const decodedSlug = safeDecode(rawSlug);
  const eventTypeSlug = rawType === undefined ? null : safeDecode(rawType);
  if (!decodedSlug || (rawType !== undefined && !eventTypeSlug)) return null;
  const teamSlug = slugify(decodedSlug);
  if (!teamSlug) return null;

  try {
    // Loaded lazily, like the org resolver, so that with organizations disabled no Prisma is pulled in.
    const { handleOrgRedirect } = await import("@lib/handleOrgRedirect");
    const redirect = await handleOrgRedirect({
      slugs: [teamSlug],
      redirectType: eventTypeSlug ? RedirectType.TeamEventType : RedirectType.Team,
      eventTypeSlug,
      query: toParsedUrlQuery(req.nextUrl.searchParams),
      hostOrgId,
    });
    return redirect?.redirect.destination ?? null;
  } catch (error) {
    // The page repeats this lookup, so a failure here only costs the HTTP-level redirect.
    console.error("proxy: team redirect lookup failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
};

const proxy = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const url = req.nextUrl;
  const resolution = await resolveRequestOrganization(req.headers.get("host") ?? url.host);

  if (resolution.kind === "unknown-host") {
    return new NextResponse("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  if (resolution.kind === "error") {
    return new NextResponse("Service Unavailable", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }

  // Mirrors getHostOrganization: without a host org (or one lacking a slug) the team pages 404 before their
  // own redirect lookup, so non-org (hostOrgId null) redirects only exist with organizations disabled (T430).
  if (isOrganizationsEnabled() && resolution.org?.slug) {
    const destination = await getMovedTeamRedirect(req, resolution.org.id);
    if (destination) return NextResponse.redirect(new URL(destination, url), 308);
  }

  if (!isLegacyProxyRoute(url.pathname)) {
    const headers = new Headers(req.headers);
    applyOrgHeaders(headers, resolution.org);
    return NextResponse.next({ request: { headers: sanitizeRequestHeaders(headers) } });
  }

  const reqWithEnrichedHeaders = enrichRequestWithHeaders({ req });
  const requestHeaders = new Headers(reqWithEnrichedHeaders.headers);
  stripOrgHeaders(requestHeaders);

  if (url.pathname.startsWith("/api/auth/signup")) {
    const isSignupDisabled = await safeGet<boolean>("isSignupDisabled");
    // If is in maintenance mode, point the url pathname to the maintenance page
    if (isSignupDisabled) {
      // TODO: Consider using responseWithHeaders here
      return NextResponse.json({ error: "Signup is disabled" }, { status: 503 });
    }
  }

  if (url.pathname.startsWith("/apps/installed")) {
    const returnTo = reqWithEnrichedHeaders.cookies.get("return-to");

    if (returnTo?.value) {
      const response = NextResponse.redirect(new URL(returnTo.value, reqWithEnrichedHeaders.url), {
        headers: requestHeaders,
      });
      response.cookies.delete("return-to");
      return response;
    }
  }

  applyOrgHeaders(requestHeaders, resolution.org);
  const res = NextResponse.next({
    request: {
      headers: sanitizeRequestHeaders(requestHeaders),
    },
  });

  if (url.pathname.startsWith("/auth/logout")) {
    res.cookies.delete("next-auth.session-token");
  }

  return responseWithHeaders({ url, res, req: reqWithEnrichedHeaders });
};

const embeds = {
  addResponseHeaders: ({ url, res }: { url: URL; res: NextResponse }) => {
    if (!url.pathname.endsWith("/embed")) {
      return res;
    }
    const isCOEPEnabled = url.searchParams.get("flag.coep") === "true";
    if (isCOEPEnabled) {
      res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    }

    const embedColorScheme = url.searchParams.get("ui.color-scheme");
    if (embedColorScheme) {
      res.headers.set("x-embedColorScheme", embedColorScheme);
    }

    res.headers.set("x-isEmbed", "true");
    return res;
  },
};

const contentSecurityPolicy = {
  addResponseHeaders: ({ res, req }: { res: NextResponse; req: NextRequest }) => {
    const nonce = req.headers.get("x-csp-nonce");
    if (!nonce) {
      res.headers.set("x-csp-status", "not-opted-in");
      return res;
    }
    const cspHeader = getCspHeader({ shouldEnforceCsp: shouldEnforceCsp(req.nextUrl), nonce });
    if (cspHeader) {
      res.headers.set(cspHeader.name, cspHeader.value);
    }
    return res;
  },
  addRequestHeaders: ({ req }: { req: NextRequest }) => {
    if (!process.env.CSP_POLICY) {
      return req;
    }
    const isCspApplicable = isPagePathRequest(req.nextUrl);
    if (!isCspApplicable) {
      return req;
    }
    const nonce = getCspNonce();
    req.headers.set("x-csp-nonce", nonce);
    return req;
  },
};

function responseWithHeaders({ url, res, req }: { url: URL; res: NextResponse; req: NextRequest }) {
  const resWithCSP = contentSecurityPolicy.addResponseHeaders({ res, req });
  const resWithEmbeds = embeds.addResponseHeaders({ url, res: resWithCSP });
  return resWithEmbeds;
}

function enrichRequestWithHeaders({ req }: { req: NextRequest }) {
  const reqWithCSP = contentSecurityPolicy.addRequestHeaders({ req });
  return reqWithCSP;
}

export const config = {
  // The x-cal-org-* request headers are only trustworthy if every route that can read them passes
  // through here to have client-supplied copies stripped, so this runs on everything but build assets.
  // File extensions are not excluded: /:user/avatar.png rewrites to an API route.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export default proxy;
