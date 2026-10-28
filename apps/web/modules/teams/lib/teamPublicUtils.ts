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

export type TeamPageSelection =
  | { kind: "overview" }
  | { kind: "team" }
  | { kind: "member"; username: string };

export const TEAM_VIEW_PARAM_VALUE = "team";

export function resolveSelectedMember(
  members: PublicTeamMemberDto[],
  username: string | null
): PublicTeamMemberDto | null {
  if (!username) return null;
  return members.find((member) => member.username === username) ?? null;
}

export function parseSelection(
  members: PublicTeamMemberDto[],
  { member, view }: { member: string | null; view: string | null }
): TeamPageSelection {
  const selectedMember = resolveSelectedMember(members, member);
  if (selectedMember) return { kind: "member", username: selectedMember.username };
  if (view === TEAM_VIEW_PARAM_VALUE) return { kind: "team" };
  return { kind: "overview" };
}

export function buildSelectionSearch(currentSearch: string, selection: TeamPageSelection): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("member");
  params.delete("view");
  if (selection.kind === "member") {
    params.set("member", selection.username);
  } else if (selection.kind === "team") {
    params.set("view", TEAM_VIEW_PARAM_VALUE);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
