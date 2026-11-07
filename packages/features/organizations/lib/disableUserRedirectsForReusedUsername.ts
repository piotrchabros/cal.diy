import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { getTempOrgRedirectRepository } from "../di/TempOrgRedirectRepository.container";

export async function disableUserRedirectsForReusedUsername(p: {
  organizationId: number | null | undefined;
  username: string;
}): Promise<void> {
  if (!p.organizationId || !isOrganizationsEnabled()) return;

  // The new owner of a username freed by a move wins over the redirect the move left behind (US5-6).
  await getTempOrgRedirectRepository().disableByFrom({
    fromOrgId: p.organizationId,
    from: p.username,
    types: ["User"],
  });
}
