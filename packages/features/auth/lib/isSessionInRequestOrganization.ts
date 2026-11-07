import type { IncomingHttpHeaders } from "node:http";
import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

const log = logger.getSubLogger({ prefix: ["isSessionInRequestOrganization"] });

// Lookup failures are not caught on purpose: the session must fail closed instead of being
// accepted on a host it does not belong to.
export async function isSessionInRequestOrganization({
  userId,
  headers,
}: {
  userId: number;
  headers: Pick<Headers, "get"> | IncomingHttpHeaders;
}): Promise<boolean> {
  if (!isOrganizationsEnabled()) return true;

  // Loaded lazily so flag-off paths never pull in Prisma.
  const { toHeadersGetter } = await import("@calcom/features/organizations/lib/getHostOrganization");
  const { getOrgFromRequest } = await import("@calcom/features/organizations/lib/getOrgFromRequest");
  const { getOrganizationSignInService } = await import(
    "@calcom/features/organizations/di/OrganizationSignInService.container"
  );

  const org = await getOrgFromRequest(toHeadersGetter(headers));
  const requestOrganizationId = org?.id ?? null;
  const ok = await getOrganizationSignInService().isUserInOrganization({
    userId,
    organizationId: requestOrganizationId,
  });

  if (!ok)
    log.warn("Session user does not belong to the request organization", { userId, requestOrganizationId });
  return ok;
}
