import type { ParsedUrlQuery } from "node:querystring";
import { stringify } from "node:querystring";
import type { RedirectTypeDto } from "@calcom/features/organizations/repositories/interfaces/ITempOrgRedirectRepository";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";

const log = logger.getSubLogger({ prefix: ["lib", "handleOrgRedirect"] });

const SINGLE_SEGMENT_PATH = /^\/[^/]+$/;

function trimTrailingSlashes(pathname: string) {
  return pathname.replace(/\/+$/, "");
}

function buildSearchString(query: ParsedUrlQuery) {
  const filteredQuery: ParsedUrlQuery = {};
  for (const [key, value] of Object.entries(query)) {
    // querystring.stringify turns undefined into an empty value, so drop those entries
    if (key === "orgRedirection" || value === undefined) continue;
    filteredQuery[key] = value;
  }
  const queryString = stringify(filteredQuery);
  return queryString ? `?${queryString}` : "";
}

// TempOrgRedirect rows created outside any organization use fromOrgId 0
export const NON_ORG_REDIRECT_FROM_ORG_ID = 0;

export type OrgRedirect = { redirect: { permanent: true; destination: string } };

export interface HandleOrgRedirectParams {
  slugs: string[];
  redirectType: RedirectTypeDto;
  eventTypeSlug: string | null;
  /** Search params only - see omitRouteParams */
  query: ParsedUrlQuery;
  /** Organization serving the request, null when organizations are disabled */
  hostOrgId: number | null;
}

/**
 * Keeps existing user and team links working after they move into an organization.
 * Example: user "john87" becomes "john" in organization "acme", so cal.com/john87 redirects to the
 * organization's domain at /john.
 *
 * Unlike the old implementation there is no `orgRedirection` loop guard: lookups are keyed on the
 * organization the old link belonged to, and the target lives on the new organization's domain, so
 * following a redirect never matches the same row again.
 */
export async function handleOrgRedirect({
  slugs,
  redirectType,
  eventTypeSlug,
  query,
  hostOrgId,
}: HandleOrgRedirectParams): Promise<OrgRedirect | null> {
  if (!slugs.length) return null;

  const fromOrgId = hostOrgId ?? NON_ORG_REDIRECT_FROM_ORG_ID;
  const { getTempOrgRedirectRepository } = await import(
    "@calcom/features/organizations/di/TempOrgRedirectRepository.container"
  );
  const redirects = await getTempOrgRedirectRepository().findEnabledByFromSlugs({
    fromOrgId,
    type: redirectType,
    fromSlugs: slugs,
  });

  const toUrlBySlug = new Map(redirects.map((redirect) => [redirect.from, redirect.toUrl]));

  // A dynamic group is redirected only when every member moved; otherwise the group would be split
  const targets: URL[] = [];
  for (const slug of slugs) {
    const toUrl = toUrlBySlug.get(slug);
    if (!toUrl) return null;
    try {
      targets.push(new URL(toUrl));
    } catch {
      log.warn("Invalid TempOrgRedirect toUrl", safeStringify({ slugs, fromOrgId }));
      return null;
    }
  }

  const origin = targets[0].origin;
  if (targets.some((target) => target.origin !== origin)) return null;

  let path: string;
  if (targets.length === 1) {
    path = trimTrailingSlashes(targets[0].pathname);
  } else {
    const segments: string[] = [];
    for (const target of targets) {
      const trimmedPathname = trimTrailingSlashes(target.pathname);
      if (!SINGLE_SEGMENT_PATH.test(trimmedPathname)) return null;
      segments.push(trimmedPathname.slice(1));
    }
    // Input order matters: the first user's settings drive the dynamic group page
    path = `/${segments.join("+")}`;
  }

  if (eventTypeSlug) {
    path = `${path}/${encodeURIComponent(eventTypeSlug)}`;
  }

  const destination = `${origin}${path || "/"}${buildSearchString(query)}`;
  log.debug(`Suggesting redirect from ${slugs} to ${destination}`);

  return { redirect: { destination, permanent: true } };
}

export async function getRedirectWithOriginAndSearchString(
  params: Omit<HandleOrgRedirectParams, "eventTypeSlug">
): Promise<{ origin: string; searchString: string } | null> {
  const orgRedirect = await handleOrgRedirect({ ...params, eventTypeSlug: null });
  if (!orgRedirect) return null;

  const url = new URL(orgRedirect.redirect.destination);
  return { origin: url.origin, searchString: url.search };
}

/**
 * buildLegacyCtx merges route params into `query`; without removing them, `user` and `type`
 * would leak into the redirect's search string.
 */
export function omitRouteParams(query: ParsedUrlQuery, params: ParsedUrlQuery | undefined): ParsedUrlQuery {
  const searchParams: ParsedUrlQuery = { ...query };
  if (!params) return searchParams;
  for (const key of Object.keys(params)) {
    delete searchParams[key];
  }
  return searchParams;
}
