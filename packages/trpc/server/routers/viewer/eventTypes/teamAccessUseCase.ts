import type { Membership, Team } from "@calcom/prisma/client";

type TeamMembershipWithTeam = Membership & {
  team: Team & {
    parent?: {
      id: number;
      name: string;
      slug: string | null;
      logoUrl: string | null;
      parentId: number | null;
      metadata: any;
    } | null;
  };
};

export class TeamAccessUseCase {
  // Every team role may read its team's event types, so an accepted membership is all that is needed;
  // this replaces an always-true PBAC stub (T311).
  async filterTeamsByEventTypeReadPermission(
    memberships: TeamMembershipWithTeam[]
  ): Promise<TeamMembershipWithTeam[]> {
    return memberships.filter((membership) => !membership.team.isOrganization && membership.accepted);
  }
}
