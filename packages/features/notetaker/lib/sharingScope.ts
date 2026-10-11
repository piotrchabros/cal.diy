import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { NotetakerEventTypeContext } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { INotetakerMembershipLookup } from "./membershipLookup";

export type NotetakerSharingTeam = {
  teamId: number | null;
  teamName: string | null;
  organizationId: number | null;
  /** Owner of a personal event type, who must stay an accepted member of teamId. Null for a team event type. */
  sharingOwnerUserId: number | null;
};

export type NotetakerSharingSource = NotetakerSharingTeam & { sharingMode: NotetakerSharingModeDto };

export type NotetakerSharingScope = {
  mode: "TEAM" | "SELECTED_PEOPLE";
  teamId: number;
  teamName: string;
  /** organizationId ?? teamId: where a selected person must be an accepted member. */
  eligibilityTeamId: number;
};

/** Pure. Used by both Prisma repositories and the in-memory fakes. */
export function deriveNotetakerSharingTeam(input: {
  eventTypeTeam: { id: number; name: string; parentId: number | null } | null;
  eventTypeUserId: number | null;
  chosenTeam: { id: number; name: string } | null;
}): NotetakerSharingTeam {
  const { eventTypeTeam, eventTypeUserId, chosenTeam } = input;
  if (eventTypeTeam) {
    return {
      teamId: eventTypeTeam.id,
      teamName: eventTypeTeam.name,
      organizationId: eventTypeTeam.parentId,
      sharingOwnerUserId: null,
    };
  }
  if (!chosenTeam || eventTypeUserId === null) {
    return { teamId: null, teamName: null, organizationId: null, sharingOwnerUserId: null };
  }
  return {
    teamId: chosenTeam.id,
    teamName: chosenTeam.name,
    // The audience of a personal event type is the chosen team itself, never its parent.
    organizationId: null,
    sharingOwnerUserId: eventTypeUserId,
  };
}

export function toNotetakerSharingSource(context: NotetakerEventTypeContext): NotetakerSharingSource {
  return {
    teamId: context.effectiveSharingTeamId,
    teamName: context.effectiveSharingTeamName,
    // context.organizationId describes the event type's own team, which a personal event type lacks.
    organizationId: context.teamId !== null ? context.organizationId : null,
    sharingOwnerUserId: context.sharingOwnerUserId,
    sharingMode: context.settings?.sharingMode ?? "HOSTS_ONLY",
  };
}

/** null when mode is HOSTS_ONLY, there is no team, or the owner of a personal event type is not an accepted member. */
export async function resolveNotetakerSharingScope(
  source: NotetakerSharingSource,
  membershipLookup: Pick<INotetakerMembershipLookup, "isAcceptedMember">
): Promise<NotetakerSharingScope | null> {
  if (source.sharingMode === "HOSTS_ONLY" || source.teamId === null) return null;
  if (source.sharingOwnerUserId !== null) {
    const ownerIsMember = await membershipLookup.isAcceptedMember({
      userId: source.sharingOwnerUserId,
      teamId: source.teamId,
    });
    if (!ownerIsMember) return null;
  }
  return {
    mode: source.sharingMode,
    teamId: source.teamId,
    teamName: source.teamName ?? "",
    eligibilityTeamId: source.organizationId ?? source.teamId,
  };
}
