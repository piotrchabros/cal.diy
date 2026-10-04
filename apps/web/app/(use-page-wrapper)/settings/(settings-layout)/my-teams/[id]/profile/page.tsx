import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { teamsRouter } from "@calcom/trpc/server/routers/viewer/teams/_router";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { createRouterCaller } from "app/_trpc/context";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import TeamProfileView from "~/settings/teams/team-profile-view";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("team_profile"),
    (t) => t("manage_settings_for_your_team_profile"),
    undefined,
    undefined,
    "/settings/my-teams/profile"
  );

const Page = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const teamId = Number(id);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    notFound();
  }

  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  const teamsCaller = await createRouterCaller(teamsRouter);
  try {
    const team = await teamsCaller.getProfile({ teamId });
    return <TeamProfileView team={team} />;
  } catch {
    notFound();
  }
};

export default Page;
