import { WEBAPP_URL } from "@calcom/lib/constants";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

export async function getBookingOrganizationBaseUrl({
  teamId,
  organizerUserId,
}: {
  teamId: number | null | undefined;
  organizerUserId: number | null | undefined;
}): Promise<string> {
  // No Prisma load while the feature is off.
  if (!isOrganizationsEnabled()) return WEBAPP_URL;

  const { getOrganizationUrlService } = await import("../di/OrganizationUrlService.container");
  const organizationUrlService = getOrganizationUrlService();
  if (teamId !== null && teamId !== undefined) return organizationUrlService.getBaseUrlForTeam({ teamId });
  return organizationUrlService.getBaseUrlForUser({ userId: organizerUserId });
}
