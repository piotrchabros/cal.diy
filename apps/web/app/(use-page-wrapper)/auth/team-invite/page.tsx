import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import type { PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import TeamInviteView from "~/auth/team-invite-view";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("join_team"),
    (t) => t("team_invite_set_password_description"),
    undefined,
    undefined,
    "/auth/team-invite"
  );

const Page = async ({ searchParams: _searchParams }: PageProps) => {
  const searchParams = await _searchParams;
  const token = typeof searchParams?.token === "string" ? searchParams.token : "";
  const invite = token ? await new TeamMembersService().getInviteByToken({ token }) : null;
  if (!invite) {
    return <TeamInviteView invite={null} token={token} />;
  }

  const membersPath = `/settings/my-teams/${invite.teamId}/members`;
  if (!invite.needsPassword) {
    const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
    if (session?.user?.email?.toLowerCase() === invite.email) {
      redirect(membersPath);
    }
    const loginParams = new URLSearchParams({ email: invite.email, callbackUrl: membersPath });
    redirect(`/auth/login?${loginParams.toString()}`);
  }

  return <TeamInviteView invite={invite} token={token} />;
};

export default Page;
