import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { Button } from "@calcom/ui/components/button";
import { _generateMetadata, getTranslate } from "app/_utils";
import OrganizationsListingView from "~/organizations/views/organizations-listing-view";
import { requireOrganizationsAdmin } from "./_lib/requireOrganizationsAdmin";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("organizations"),
    (t) => t("admin_organizations_description"),
    undefined,
    undefined,
    "/settings/admin/organizations"
  );

const Page = async () => {
  await requireOrganizationsAdmin();
  const t = await getTranslate();
  return (
    <SettingsHeader
      title={t("organizations")}
      description={t("admin_organizations_description")}
      CTA={<Button href="/settings/admin/organizations/new">{t("add_organization")}</Button>}>
      <OrganizationsListingView />
    </SettingsHeader>
  );
};

export default Page;
