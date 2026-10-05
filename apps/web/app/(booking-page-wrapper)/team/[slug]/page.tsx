import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { prisma } from "@calcom/prisma";
import type { PageProps } from "app/_types";
import { _generateMetadataForStaticPage } from "app/_utils";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";
import { TeamPublicView } from "~/teams/views/team-public-view";

const getPublicTeam = async (slug: string) => {
  const service = new TeamProfileService(prisma);
  return service.getPublicTeamBySlug({ slug: decodeURIComponent(slug) });
};

const Page = async ({ params }: PageProps): Promise<ReactElement> => {
  const { slug } = await params;
  if (typeof slug !== "string" || !slug) {
    return notFound();
  }
  const team = await getPublicTeam(slug);
  if (!team) {
    return notFound();
  }
  return <TeamPublicView team={team} />;
};

export const generateMetadata = async ({ params }: PageProps) => {
  const { slug } = await params;
  if (typeof slug !== "string" || !slug) {
    return {};
  }
  const team = await getPublicTeam(slug);
  if (!team) {
    return {};
  }
  return _generateMetadataForStaticPage(team.name, team.bio ?? "", false, undefined, `/team/${team.slug}`);
};

export default Page;
