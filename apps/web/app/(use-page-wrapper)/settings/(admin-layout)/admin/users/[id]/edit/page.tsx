import { getUserRepository } from "@calcom/features/di/containers/UserRepository";
import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { Params } from "app/_types";
import { _generateMetadata, getTranslate } from "app/_utils";
import { z } from "zod";
import { UsersEditView } from "~/users/views/users-edit-view";

const userIdSchema = z.object({ id: z.coerce.number() });

export const generateMetadata = async ({ params }: { params: Params }) => {
  const input = userIdSchema.safeParse(await params);
  if (!input.success) {
    return await _generateMetadata(
      (t) => t("editing_user"),
      (t) => t("admin_users_edit_description"),
      undefined,
      undefined,
      "/settings/admin/users/edit"
    );
  }

  const user = await getUserRepository().adminFindById(input.data.id);

  return await _generateMetadata(
    (t) => `${t("editing_user")}: ${user.username}`,
    (t) => t("admin_users_edit_description"),
    undefined,
    undefined,
    `/settings/admin/users/${input.data.id}/edit`
  );
};

const Page = async ({ params }: { params: Params }) => {
  const input = userIdSchema.safeParse(await params);

  if (!input.success) throw new Error("Invalid access");

  const user = await getUserRepository().adminFindById(input.data.id);

  const t = await getTranslate();

  return (
    <SettingsHeader title={t("editing_user")} description={t("admin_users_edit_description")}>
      <UsersEditView user={user} organizationsEnabled={isOrganizationsEnabled()} />
    </SettingsHeader>
  );
};

export default Page;
