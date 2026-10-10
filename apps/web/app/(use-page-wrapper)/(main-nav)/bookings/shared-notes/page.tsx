import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { NotetakerSharedResultsList } from "@calcom/web/modules/notetaker/components/NotetakerSharedResultsList";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { _generateMetadata, getTranslate } from "app/_utils";
import { ShellMainAppDir } from "app/(use-page-wrapper)/(main-nav)/ShellMainAppDir";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("notetaker_shared_with_me_title"),
    (t) => t("notetaker_shared_with_me_description"),
    undefined,
    undefined,
    "/bookings/shared-notes"
  );

const Page = async () => {
  const t = await getTranslate();
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  return (
    <ShellMainAppDir
      heading={t("notetaker_shared_with_me_title")}
      subtitle={t("notetaker_shared_with_me_description")}
      backPath="/bookings/upcoming">
      <NotetakerSharedResultsList />
    </ShellMainAppDir>
  );
};

export default Page;
