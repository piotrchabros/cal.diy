import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { NotetakerResultsPage } from "@calcom/web/modules/notetaker/components/NotetakerResultsPage";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import type { PageProps } from "app/_types";
import { _generateMetadata, getTranslate } from "app/_utils";
import { ShellMainAppDir } from "app/(use-page-wrapper)/(main-nav)/ShellMainAppDir";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export const generateMetadata = async ({ params }: { params: Promise<{ uid: string }> }) =>
  await _generateMetadata(
    (t) => t("notetaker_transcript_title"),
    (t) => t("notetaker_transcript_description"),
    undefined,
    undefined,
    `/booking/${(await params).uid}/notetaker`
  );

const Page = async ({ params }: PageProps) => {
  const resolvedParams = await params;
  const bookingUid = resolvedParams.uid;

  if (!bookingUid || typeof bookingUid !== "string") {
    redirect("/bookings/upcoming");
  }

  const t = await getTranslate();
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  return (
    <ShellMainAppDir
      heading={t("notetaker_transcript_title")}
      subtitle={t("notetaker_transcript_description")}>
      <NotetakerResultsPage bookingUid={bookingUid} />
    </ShellMainAppDir>
  );
};

export default Page;
