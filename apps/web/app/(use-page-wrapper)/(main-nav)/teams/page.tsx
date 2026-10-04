import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import type { TeamsListTeam } from "~/teams/lib/teamsListUtils";
import { getTeamPublicUrl } from "~/teams/lib/teamsListUtils";
import { TeamsListingView } from "~/teams/views/teams-listing-view";

const Page = async (): Promise<ReactElement> => {
  const session = await getServerSession({
    req: buildLegacyRequest(await headers(), await cookies()),
  });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: session.user.id, accepted: true },
    select: {
      role: true,
      team: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bio: true,
        },
      },
    },
    orderBy: { team: { name: "asc" } },
  });

  const teams: TeamsListTeam[] = memberships.map((membership) => ({
    id: membership.team.id,
    name: membership.team.name,
    slug: membership.team.slug,
    logoUrl: membership.team.logoUrl,
    bio: membership.team.bio,
    role: membership.role,
    publicUrl: getTeamPublicUrl(WEBAPP_URL, membership.team.slug),
  }));

  return <TeamsListingView teams={teams} />;
};

export const generateMetadata = async (): Promise<ReturnType<typeof _generateMetadata>> =>
  await _generateMetadata(
    (t) => t("teams"),
    (t) => t("create_manage_teams_collaborative"),
    undefined,
    undefined,
    "/teams"
  );

export default Page;
