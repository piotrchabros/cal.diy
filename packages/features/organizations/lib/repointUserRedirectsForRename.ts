import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { getOrganizationUrlService } from "../di/OrganizationUrlService.container";
import { getTempOrgRedirectRepository } from "../di/TempOrgRedirectRepository.container";

export async function repointUserRedirectsForRename(p: {
  organizationId: number | null | undefined;
  oldUsername: string | null | undefined;
  newUsername: string;
}): Promise<void> {
  if (!p.organizationId || !p.oldUsername || p.oldUsername === p.newUsername) return;
  if (!isOrganizationsEnabled()) return;

  // Move redirects (FR-018) point at the user's page in their current organization. Matching on that
  // exact URL keeps links into the old username working after a rename without touching redirects that
  // other organizations keep for their own users with the same username.
  const baseUrl = await getOrganizationUrlService().getBaseUrl({ organizationId: p.organizationId });
  await getTempOrgRedirectRepository().updateToUrl({
    types: ["User"],
    toUrl: `${baseUrl}/${p.oldUsername}`,
    newToUrl: `${baseUrl}/${p.newUsername}`,
  });
}
