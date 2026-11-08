import { createPaymentCallbackHandler } from "@calcom/app-store/stripepayment/api/paymentCallback";
import sendVerificationRequest from "@calcom/features/auth/lib/sendVerificationRequest";
import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import { assignPremiumUsername } from "@server/lib/stripepayment/assignPremiumUsername";

// app-store cannot import features/organizations, so the verification email sender, the premium username
// assigner (through addMember) and the organization base URL are injected here; this static route shadows
// the integrations [...args] catch-all, like webhook.ts next to it
export default createPaymentCallbackHandler({
  sendVerificationRequest,
  assignUsername: assignPremiumUsername,
  getBaseUrl: ({ organizationId }) => getOrganizationUrlService().getBaseUrl({ organizationId }),
});
