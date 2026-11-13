// An organization's own Team row has parentId null, so its organization is the row itself.
export function getTeamOrganizationId(team: {
  id: number;
  isOrganization: boolean;
  parentId: number | null;
}): number | null {
  return team.isOrganization ? team.id : team.parentId;
}
