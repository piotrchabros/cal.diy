import { WEBAPP_URL } from "@calcom/lib/constants";
import {
  getDefaultOrganizationDomain,
  getOrganizationBaseUrlFromDomain,
} from "@calcom/lib/organizations/getOrganizationBaseUrlFromDomain";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import prisma from "@calcom/prisma";

// app-store cannot depend on @calcom/features, so the organization-domain lookups live here as
// select-only mirrors of PrismaOrganizationRepository: isKnownOrganizationDomain mirrors
// findByDomain's predicate (a root organization team whose OrganizationSettings.customDomain
// matches), and getOrganizationDomainById mirrors findDomainById. Same pattern as the T510/T521
// injection precedent is disproportionate here because api/get.ts is a Next API route with no
// apps/web caller to inject from. Inert while organizations are off.
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

export async function getOrganizationDomainById(organizationId: number | null): Promise<string | null> {
  if (!isOrganizationsEnabled() || organizationId === null) return null;
  const organization = await prisma.team.findFirst({
    where: { id: organizationId, isOrganization: true, parentId: null },
    select: { organizationSettings: { select: { customDomain: true } } },
  });
  return organization?.organizationSettings?.customDomain ?? null;
}

export async function getOrganizationBaseUrl(organizationId: number | null): Promise<string> {
  const domain = await getOrganizationDomainById(organizationId);
  if (!domain) return WEBAPP_URL;
  return getOrganizationBaseUrlFromDomain(domain, getDefaultOrganizationDomain());
}
