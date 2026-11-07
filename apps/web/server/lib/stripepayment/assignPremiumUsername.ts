import type { AssignPremiumUsername } from "@calcom/app-store/stripepayment/api/paymentCallback";
import { getOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";

export const assignPremiumUsername: AssignPremiumUsername = async ({ userId, organizationId, username }) => {
  await getOrganizationMembershipService().addMember({ organizationId, userId, role: "MEMBER", username });
};
