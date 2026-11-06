import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";

const log = logger.getSubLogger({ prefix: ["getOrganizerOrganizationRedirect"] });

export function buildPathWithQuery(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
  excludeKeys: string[]
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || excludeKeys.includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export async function getOrganizerOrganizationRedirect({
  headers,
  organizerUserId,
  teamId,
  path,
}: {
  headers: Pick<Headers, "get">;
  organizerUserId: number | null;
  teamId: number | null;
  path: string;
}): Promise<string | null> {
  if (!isOrganizationsEnabled()) return null;
  if (organizerUserId === null && teamId === null) return null;

  try {
    const { getOrganizationUrlService } = await import("../di/OrganizationUrlService.container");
    const organizationUrlService = getOrganizationUrlService();
    const baseUrl =
      organizerUserId !== null
        ? await organizationUrlService.getBaseUrlForUser({ userId: organizerUserId })
        : await organizationUrlService.getBaseUrlForTeam({ teamId });

    // Comparing against the request Host rather than the request's organization keeps this loop-free:
    // after the redirect the request arrives on the organizer's host, so it matches and stops.
    if (normalizeHost(new URL(baseUrl).host) === normalizeHost(headers.get("host"))) return null;

    return `${baseUrl.replace(/\/+$/, "")}${path}`;
  } catch (error) {
    log.error("Failed to resolve organizer organization redirect", {
      organizerUserId,
      teamId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
