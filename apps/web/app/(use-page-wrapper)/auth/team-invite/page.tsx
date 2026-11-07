import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
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

function getLandingPath(invite: { teamId: number; isOrganization: boolean }): string {
  if (!invite.isOrganization) return `/settings/my-teams/${invite.teamId}/members`;
  // With organizations off there is no organization members page to land on.
  return isOrganizationsEnabled() ? "/settings/organization/members" : "/";
}

const Page = async ({ searchParams: _searchParams }: PageProps) => {
  const searchParams = await _searchParams;
  const token = typeof searchParams?.token === "string" ? searchParams.token : "";
  const invite = token ? await new TeamMembersService().getInviteByToken({ token }) : null;
  if (!invite) {
    return <TeamInviteView invite={null} token={token} landingPath="/" />;
  }

  const landingPath = getLandingPath(invite);
  if (!invite.needsPassword && !invite.needsUsername) {
    const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
    if (session?.user?.email?.toLowerCase() === invite.email) {
      redirect(landingPath);
    }
    const loginParams = new URLSearchParams({ email: invite.email, callbackUrl: landingPath });
    redirect(`/auth/login?${loginParams.toString()}`);
  }

  return (
    <TeamInviteView
      invite={{
        teamId: invite.teamId,
        teamName: invite.teamName,
        email: invite.email,
        isOrganization: invite.isOrganization,
        needsPassword: invite.needsPassword,
        needsUsername: invite.needsUsername,
      }}
      token={token}
      landingPath={landingPath}
    />
  );
};

export default Page;
