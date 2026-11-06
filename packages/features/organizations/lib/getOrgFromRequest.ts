import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { readOrgFromHeaders } from "./orgRequestHeaders";

export async function getOrgFromRequest(
  headers: Pick<Headers, "get">
): Promise<RequestOrganizationDto | null> {
  const fromHeaders = readOrgFromHeaders(headers);
  if (fromHeaders) return fromHeaders;

  // Loaded lazily so callers behind the proxy, which always have the headers, never pull in Prisma.
  const { getOrganizationDomainResolver } = await import("../di/OrganizationDomainResolver.container");
  return getOrganizationDomainResolver().resolve(headers.get("host"));
}
