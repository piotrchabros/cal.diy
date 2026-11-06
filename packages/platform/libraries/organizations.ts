import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import { WEBAPP_URL } from "@calcom/lib/constants";

/**
 * @deprecated Always returns the default domain; use getBookerBaseUrl(organizationId)
 */
export function getBookerBaseUrlSync(_orgSlug: string | null): string {
  return WEBAPP_URL;
}

export async function getBookerBaseUrl(organizationId: number | null): Promise<string> {
  return getOrganizationUrlService().getBaseUrl({ organizationId });
}

// Stub billing service for API v2 — org billing removed in community edition
class ActiveUserBillingServiceStub {
  async getActiveUserCountForPlatformOrg(
    _subscriptionId: string,
    _invoiceStart: Date,
    _invoiceEnd: Date
  ): Promise<number> {
    return 0;
  }
}

const activeUserBillingServiceStub = new ActiveUserBillingServiceStub();

export function getActiveUserBillingService(): ActiveUserBillingServiceStub {
  return activeUserBillingServiceStub;
}
