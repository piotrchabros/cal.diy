import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import type { Params } from "app/_types";
import { _generateMetadata, getTranslate } from "app/_utils";
import { notFound } from "next/navigation";
import { z } from "zod";
import OrganizationFormView from "~/organizations/views/organization-form-view";
import { requireOrganizationsAdmin } from "../../_lib/requireOrganizationsAdmin";

const idSchema = z.object({ id: z.coerce.number().int().positive() });

export const generateMetadata = async ({ params }: { params: Params }) => {
  const input = idSchema.safeParse(await params);
  if (!input.success) {
    return await _generateMetadata(
      (t) => t("editing_organization"),
      (t) => t("admin_organizations_edit_description"),
      undefined,
      undefined,
      "/settings/admin/organizations"
    );
  }

  return await _generateMetadata(
    (t) => t("editing_organization"),
    (t) => t("admin_organizations_edit_description"),
    undefined,
    undefined,
    `/settings/admin/organizations/${input.data.id}/edit`
  );
};

const Page = async ({ params }: { params: Params }) => {
  await requireOrganizationsAdmin();
  const input = idSchema.safeParse(await params);

  if (!input.success) notFound();

  const t = await getTranslate();

  return (
    <SettingsHeader title={t("editing_organization")} description={t("admin_organizations_edit_description")}>
      <OrganizationFormView organizationId={input.data.id} />
    </SettingsHeader>
  );
};

export default Page;
