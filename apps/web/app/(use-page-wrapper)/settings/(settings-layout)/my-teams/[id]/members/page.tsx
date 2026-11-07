import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import prisma from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import type { PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import MembersView from "~/settings/teams/members-view";

export const generateMetadata = async ({ params }: { params: Promise<{ id: string }> }) =>
  await _generateMetadata(
    (t) => t("team_members"),
    (t) => t("members_team_description"),
    undefined,
    undefined,
    `/settings/my-teams/${(await params).id}/members`
  );

const Page = async ({ params: _params }: PageProps) => {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  const params = await _params;
  const teamId = Number(params?.id);
  if (!params?.id || Number.isNaN(teamId)) {
    notFound();
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { id: true, parentId: true, isOrganization: true },
  });
  if (!team || team.isOrganization) {
    notFound();
  }

  const membership = await prisma.membership.findUnique({
    where: {
      userId_teamId: {
        userId: session.user.id,
        teamId,
      },
    },
    select: {
      role: true,
      accepted: true,
    },
  });

  let isOrganizationAdmin = false;
  if (isOrganizationsEnabled() && team.parentId) {
    const organizationRole = await getOrganizationMembershipService().getRole(session.user.id, team.parentId);
    isOrganizationAdmin = organizationRole === "OWNER" || organizationRole === "ADMIN";
  }

  if (!membership && !isOrganizationAdmin) {
    notFound();
  }

  const isAcceptedTeamAdmin =
    !!membership?.accepted &&
    (membership.role === MembershipRole.OWNER || membership.role === MembershipRole.ADMIN);
  const canManage = isOrganizationAdmin || isAcceptedTeamAdmin;

  return (
    <MembersView
      teamId={teamId}
      viewerId={session.user.id}
      canManage={canManage}
      isPendingInvite={!!membership && !membership.accepted}
    />
  );
};

export default Page;
