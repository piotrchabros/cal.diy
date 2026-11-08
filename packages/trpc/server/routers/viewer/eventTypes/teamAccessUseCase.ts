export type TeamMembershipWithTeam = {
  accepted: boolean;
  team: {
    isOrganization: boolean;
  };
};

export class TeamAccessUseCase {
  // Every team role may read its team's event types, so an accepted membership is all that is needed;
  // this replaces an always-true PBAC stub (T311).
  // Generic so the filter preserves the caller's richer membership shape (T527).
  async filterTeamsByEventTypeReadPermission<TMembership extends TeamMembershipWithTeam>(
    memberships: TMembership[]
  ): Promise<TMembership[]> {
    return memberships.filter((membership) => !membership.team.isOrganization && membership.accepted);
  }
}
