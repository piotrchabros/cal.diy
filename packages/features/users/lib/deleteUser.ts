import { deleteStripeCustomer } from "@calcom/app-store/stripepayment/lib/customer";
import { getUserRepository } from "@calcom/features/di/containers/UserRepository";
import { getOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { User } from "@calcom/prisma/client";

// Refuses (PRECONDITION_FAILED) deleting the last owner of an organization; inert while organizations are off
export async function assertUserCanBeDeleted(userId: number): Promise<void> {
  if (!isOrganizationsEnabled()) return;
  await getOrganizationMembershipService().assertUserCanBeDeleted(userId);
}

export async function deleteUser(user: Pick<User, "id" | "email" | "metadata">): Promise<void> {
  await assertUserCanBeDeleted(user.id);
  await deleteStripeCustomer(user).catch(console.warn);
  await getUserRepository().deleteById({ id: user.id });
}
