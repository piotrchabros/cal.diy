import type { IncomingHttpHeaders } from "node:http";
import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { getOrgFromRequest } from "./getOrgFromRequest";

const log = logger.getSubLogger({ prefix: ["getHostOrganization"] });

function hasGet(headers: Pick<Headers, "get"> | IncomingHttpHeaders): headers is Pick<Headers, "get"> {
  return typeof (headers as { get?: unknown }).get === "function";
}

export function toHeadersGetter(headers: Pick<Headers, "get"> | IncomingHttpHeaders): Pick<Headers, "get"> {
  if (hasGet(headers)) return headers;
  return {
    get(name) {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : (value ?? null);
    },
  };
}

export type HostOrganization =
  | { status: "disabled" }
  | { status: "unresolved" }
  | { status: "resolved"; org: RequestOrganizationDto & { slug: string } };

// Shared by the user and team public pages: pages-router `req.headers` is a plain object with
// lowercased keys while the app router hands over a `Headers` instance, so both shapes are accepted.
// Errors are not caught on purpose: a failed lookup must fail closed instead of serving the page off-organization.
export async function getHostOrganization(
  headers: Pick<Headers, "get"> | IncomingHttpHeaders
): Promise<HostOrganization> {
  if (!isOrganizationsEnabled()) return { status: "disabled" };

  const org = await getOrgFromRequest(toHeadersGetter(headers));
  if (!org) return { status: "unresolved" };

  const { slug } = org;
  if (slug === null) {
    log.warn("Host organization has no slug", { organizationId: org.id });
    return { status: "unresolved" };
  }

  return { status: "resolved", org: { ...org, slug } };
}
