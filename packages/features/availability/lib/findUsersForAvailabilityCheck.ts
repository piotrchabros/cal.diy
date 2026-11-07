import { enrichUserWithDelegationCredentialsIncludeServiceAccountKey } from "@calcom/app-store/delegationCredential";
import { getUserRepository } from "@calcom/features/di/containers/UserRepository";

export async function findUsersForAvailabilityCheck({
  where,
}: {
  where: { id: number } | { username: string; organizationId: number };
}) {
  const user = await getUserRepository().findForAvailabilityCheck(where);

  if (!user) {
    return null;
  }

  return await enrichUserWithDelegationCredentialsIncludeServiceAccountKey({ user });
}
