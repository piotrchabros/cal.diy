import type { PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import prisma from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

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
    select: { id: true },
  });
  if (!team) {
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
  if (!membership) {
    notFound();
  }

  const canManage =
    membership.accepted &&
    (membership.role === MembershipRole.OWNER || membership.role === MembershipRole.ADMIN);

  return (
    <MembersView
      teamId={teamId}
      viewerId={session.user.id}
      canManage={canManage}
      isPendingInvite={!membership.accepted}
    />
  );
};

export default Page;
