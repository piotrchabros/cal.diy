export type TeamMembershipWithTeam = {
  accepted: boolean;
  team: {
    isOrganization: boolean;
  };
};

export class TeamAccessUseCase {
  // Every team role may read its team's event types, so an accepted membership is all that is needed;
  // this replaces an always-true PBAC stub (T311).
  // The organization itself counts as a team here so its event types render as their own tab (T583);
  // memberships already scope the list to the caller's teams, so nothing cross-organization leaks.
  // Generic so the filter preserves the caller's richer membership shape (T527).
  async filterTeamsByEventTypeReadPermission<TMembership extends TeamMembershipWithTeam>(
    memberships: TMembership[]
  ): Promise<TMembership[]> {
    return memberships.filter((membership) => membership.accepted);
  }
}
