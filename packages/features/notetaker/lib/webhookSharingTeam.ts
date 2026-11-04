import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { readAdHocBookingMetadata } from "./adHocMeeting";
import type { INotetakerMembershipLookup } from "./membershipLookup";
import type { NotetakerSharingSource } from "./sharingScope";
import { deriveNotetakerSharingTeam, resolveNotetakerSharingScope } from "./sharingScope";

export type MemberSharingTeamInput = {
  ownerUserId: number | null;
  eventType: {
    teamId: number | null;
    userId: number | null;
    team: { id: number; name: string; parentId: number | null } | null;
    notetakerSettings: {
      sharingMode: NotetakerSharingModeDto;
      sharingTeam: { id: number; name: string } | null;
    } | null;
  } | null;
  bookingMetadata: unknown;
};

/** [T] when the booking's results are shared with the whole team T and its owner is an accepted member of T, else []. */
export async function resolveMemberSharingTeamIds(
  input: MemberSharingTeamInput,
  membershipLookup: Pick<INotetakerMembershipLookup, "isAcceptedMember">
): Promise<number[]> {
  const { ownerUserId, eventType, bookingMetadata } = input;
  if (ownerUserId === null) return [];

  // Mirrors PrismaBookingNotetakerRepository: only a booking without an event type reads its team from the metadata.
  const adHocTeamId = eventType ? null : readAdHocBookingMetadata(bookingMetadata).sharingTeamId;
  const adHocTeam = adHocTeamId !== null ? { id: adHocTeamId, name: "" } : null;
  const sharingTeam = deriveNotetakerSharingTeam({
    eventTypeTeam: eventType?.team ?? null,
    eventTypeUserId: eventType ? eventType.userId : ownerUserId,
    chosenTeam: eventType?.notetakerSettings?.sharingTeam ?? adHocTeam,
  });

  let sharingMode: NotetakerSharingModeDto = "HOSTS_ONLY";
  if (eventType) {
    sharingMode = eventType.notetakerSettings?.sharingMode ?? "HOSTS_ONLY";
  } else if (sharingTeam.teamId !== null) {
    sharingMode = "TEAM";
  }

  return resolveMemberSharingTeamIdsForSource(
    { ownerUserId, source: { ...sharingTeam, sharingMode } },
    membershipLookup
  );
}

/** As resolveMemberSharingTeamIds, for a sharing source already derived, such as a NotetakerBookingContext. */
export async function resolveMemberSharingTeamIdsForSource(
  input: { ownerUserId: number | null; source: NotetakerSharingSource },
  membershipLookup: Pick<INotetakerMembershipLookup, "isAcceptedMember">
): Promise<number[]> {
  const { ownerUserId, source } = input;
  if (ownerUserId === null) return [];

  const scope = await resolveNotetakerSharingScope(source, membershipLookup);
  if (!scope || scope.mode !== "TEAM") return [];

  // A team event type has no sharing owner, so the scope alone does not prove the owner still belongs to the team.
  if (source.sharingOwnerUserId !== ownerUserId) {
    const ownerIsMember = await membershipLookup.isAcceptedMember({
      userId: ownerUserId,
      teamId: scope.teamId,
    });
    if (!ownerIsMember) return [];
  }
  return [scope.teamId];
}

/** Mirrors the session condition of NotetakerAccessService.isSharedViewer. */
export function isTranscriptSharedWithTeam(
  session: { colleagueSharingDisclosed: boolean; resultsDeletedAt: Date | null } | null
): boolean {
  if (!session) return false;
  return session.colleagueSharingDisclosed && session.resultsDeletedAt === null;
}
