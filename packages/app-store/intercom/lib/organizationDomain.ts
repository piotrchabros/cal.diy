import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import prisma from "@calcom/prisma";

// app-store cannot depend on @calcom/features, so this mirrors
// PrismaOrganizationRepository.findByDomain's predicate (a root organization team whose
// OrganizationSettings.customDomain matches) as a select-only existence check, the same
// pattern link.ts already uses for findDomainById. Inert while organizations are off.
export async function isKnownOrganizationDomain(hostname: string): Promise<boolean> {
  if (!isOrganizationsEnabled()) return false;
  const organization = await prisma.team.findFirst({
    where: {
      isOrganization: true,
      parentId: null,
      organizationSettings: { customDomain: hostname.toLowerCase() },
    },
    select: { id: true },
  });
  return !!organization;
}
