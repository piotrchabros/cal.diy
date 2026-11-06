import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { _generateMetadata, getTranslate } from "app/_utils";
import OrganizationFormView from "~/organizations/views/organization-form-view";
import { requireOrganizationsAdmin } from "../_lib/requireOrganizationsAdmin";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("add_organization"),
    (t) => t("admin_organizations_add_description"),
    undefined,
    undefined,
    "/settings/admin/organizations/new"
  );

const Page = async () => {
  await requireOrganizationsAdmin();
  const t = await getTranslate();

  return (
    <SettingsHeader title={t("add_organization")} description={t("admin_organizations_add_description")}>
      <OrganizationFormView />
    </SettingsHeader>
  );
};

export default Page;
