import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import type { CurrentOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { organizationRouter } from "@calcom/trpc/server/routers/viewer/organization/_router";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { createRouterCaller } from "app/_trpc/context";
import { _generateMetadata, getTranslate } from "app/_utils";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import OrgMembersView from "~/organizations/views/org-members-view";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("organization_members"),
    (t) => t("organization_members_description"),
    undefined,
    undefined,
    "/settings/organization/members"
  );

const Page = async () => {
  if (!isOrganizationsEnabled()) {
    notFound();
  }

  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  const caller = await createRouterCaller(organizationRouter);
  let organization: CurrentOrganizationDto;
  try {
    // current() is the membership check: it throws NOT_FOUND unless the viewer is an accepted org member
    organization = await caller.current();
  } catch {
    notFound();
  }

  const t = await getTranslate();

  return (
    <SettingsHeader title={t("organization_members")} description={t("organization_members_description")}>
      <OrgMembersView viewerRole={organization.viewerRole} viewerUserId={session.user.id} />
    </SettingsHeader>
  );
};

export default Page;
