import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { _generateMetadata } from "app/_utils";

import { CreateTeamView } from "./create-team-view";

export const generateMetadata = async () => {
  return await _generateMetadata(
    (t) => t("create_your_team"),
    (t) => t("create_team_form_subtitle"),
    undefined,
    undefined,
    "/teams/new"
  );
};

const Page = async () => {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  return <CreateTeamView />;
};

export default Page;
