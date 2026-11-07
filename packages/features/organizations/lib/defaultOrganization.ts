import { ErrorWithCode } from "@calcom/lib/errors";

export async function requireDefaultOrganizationId(): Promise<number> {
  // Loaded lazily so user-creation callers do not pull Prisma into their static import graph.
  const { getOrganizationDomainResolver } = await import("../di/OrganizationDomainResolver.container");
  const organizationId = (await getOrganizationDomainResolver().resolveDefault())?.id;
  if (organizationId === undefined) {
    throw ErrorWithCode.Factory.PreconditionFailed(
      "No default organization: no organization uses the domain of NEXT_PUBLIC_WEBAPP_URL"
    );
  }
  return organizationId;
}
