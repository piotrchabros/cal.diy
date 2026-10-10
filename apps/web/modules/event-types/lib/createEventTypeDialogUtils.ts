type ProfileOptionLike = {
  teamId: number | null | undefined;
  slug: string | null;
  permissions: { canCreateEventType: boolean };
};

export function findCreatableTeamProfile<T extends ProfileOptionLike>(
  profileOptions: T[],
  teamId: number | null | undefined
): T | undefined {
  if (!teamId) return undefined;
  const profile = profileOptions.find((option) => option.teamId === teamId);
  if (!profile?.permissions.canCreateEventType) return undefined;
  return profile;
}

// A bare "?..." href replaces the whole query, so the active team has to be
// carried explicitly or the button would switch the page to the personal profile.
export function getNewEventTypeHref({
  profileOptions,
  activeTeamId,
}: {
  profileOptions: ProfileOptionLike[];
  activeTeamId: number | null | undefined;
}): string {
  const teamProfile = findCreatableTeamProfile(profileOptions, activeTeamId);
  if (teamProfile) return `?dialog=new&eventPage=${teamProfile.slug ?? ""}&teamId=${activeTeamId}`;

  const personalProfile = profileOptions.find((option) => !option.teamId) ?? profileOptions[0];
  return `?dialog=new&eventPage=${personalProfile?.slug ?? ""}`;
}
