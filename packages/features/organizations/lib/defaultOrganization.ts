import { ErrorWithCode } from "@calcom/lib/errors";

export async function findDefaultOrganizationId(): Promise<number | null> {
  // Loaded lazily so user-creation callers do not pull Prisma into their static import graph.
  const { getOrganizationDomainResolver } = await import("../di/OrganizationDomainResolver.container");
  return (await getOrganizationDomainResolver().resolveDefault())?.id ?? null;
}

export async function requireDefaultOrganizationId(): Promise<number> {
  const organizationId = await findDefaultOrganizationId();
  if (organizationId === null) {
    throw ErrorWithCode.Factory.PreconditionFailed(
      "No default organization: no organization uses the domain of NEXT_PUBLIC_WEBAPP_URL"
    );
  }
  return organizationId;
}
