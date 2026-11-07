import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { getTeamProfileService } from "@calcom/features/teams/di/TeamProfileService.container";
import { getTeamPublicMembersService } from "@calcom/features/teams/di/TeamPublicMembersService.container";
import slugify from "@calcom/lib/slugify";
import { RedirectType } from "@calcom/prisma/enums";
import { TeamPublicView } from "@calcom/web/modules/teams/views/team-public-view";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
import type { PageProps } from "app/_types";
import { _generateMetadataForStaticPage } from "app/_utils";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import type { ReactElement } from "react";
import { cache } from "react";

const safeDecodeSlug = (slug: string): string | null => {
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
};

const getHost = cache(async () => getHostOrganization(await headers()));

const getPublicTeam = cache(async (slug: string, parentId: number | undefined) => {
  const decoded = safeDecodeSlug(slug);
  if (!decoded) return null;
  return getTeamProfileService().getPublicTeamBySlug({ slug: decoded, parentId });
});

const Page = async ({ params, searchParams }: PageProps): Promise<ReactElement> => {
  const { slug } = await params;
  const query = await searchParams;
  const { member, view } = query;
  if (typeof slug !== "string" || !slug) {
    return notFound();
  }
  const host = await getHost();
  if (host.status === "unresolved") {
    return notFound();
  }
  const hostOrg = host.status === "resolved" ? host.org : null;
  const decoded = safeDecodeSlug(slug);
  if (!decoded) {
    return notFound();
  }
  const redirect = await handleOrgRedirect({
    slugs: [slugify(decoded)],
    redirectType: RedirectType.Team,
    eventTypeSlug: null,
    query,
    hostOrgId: hostOrg?.id ?? null,
  });
  if (redirect) {
    permanentRedirect(redirect.redirect.destination);
  }
  const team = await getPublicTeam(slug, hostOrg?.id);
  if (!team) {
    return notFound();
  }
  const members = team.hideBookATeamMember
    ? []
    : await getTeamPublicMembersService().listByTeamId({ teamId: team.id });
  return (
    <TeamPublicView
      team={team}
      members={members}
      initialMemberUsername={typeof member === "string" ? member : null}
      initialView={typeof view === "string" ? view : null}
    />
  );
};

export const generateMetadata = async ({ params }: PageProps) => {
  const { slug } = await params;
  if (typeof slug !== "string" || !slug) {
    return {};
  }
  const host = await getHost();
  if (host.status === "unresolved") {
    return {};
  }
  const hostOrg = host.status === "resolved" ? host.org : null;
  const team = await getPublicTeam(slug, hostOrg?.id);
  if (!team) {
    return {};
  }
  return _generateMetadataForStaticPage(team.name, team.bio ?? "", false, undefined, `/team/${team.slug}`);
};

export default Page;
