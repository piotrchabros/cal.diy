import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { UserPermissionRole } from "@calcom/prisma/enums";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

// The admin layout already redirects non-admins, but permission checks belong in
// each page rather than in a layout, so every organizations page calls this itself.
export async function requireOrganizationsAdmin(): Promise<void> {
  if (!isOrganizationsEnabled()) notFound();

  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (session?.user?.role !== UserPermissionRole.ADMIN) notFound();
}
