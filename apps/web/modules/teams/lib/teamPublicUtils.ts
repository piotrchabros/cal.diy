import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";

export function getTeamEventBookingUrl(teamSlug: string | null, eventSlug: string): string {
  return `/team/${teamSlug}/${eventSlug}`;
}

export function getMemberEventBookingUrl(username: string, eventSlug: string): string {
  return `/${encodeURIComponent(username)}/${encodeURIComponent(eventSlug)}`;
}

export function getMemberProfileUrl(username: string): string {
  return `/${encodeURIComponent(username)}`;
}

export function resolveSelectedMember(
  members: PublicTeamMemberDto[],
  username: string | null
): PublicTeamMemberDto | null {
  if (!username) return null;
  return members.find((member) => member.username === username) ?? null;
}

export function buildMemberSearch(currentSearch: string, username: string | null): string {
  const params = new URLSearchParams(currentSearch);
  if (username) {
    params.set("member", username);
  } else {
    params.delete("member");
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
