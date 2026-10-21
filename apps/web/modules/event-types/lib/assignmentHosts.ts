import type { ChildrenEventType } from "@calcom/features/eventtypes/lib/childrenEventType";
import type { EventTypeSetupProps, Host, TeamMember } from "@calcom/features/eventtypes/lib/types";
import { sortHosts } from "@calcom/lib/bookings/hostGroupUtils";

type HostGroup = { id: string; name: string };

export function mapUserToValue(
  {
    id,
    name,
    username,
    avatar,
    email,
    defaultScheduleId,
  }: {
    id: number | null;
    name: string | null;
    username: string | null;
    avatar: string;
    email: string;
    defaultScheduleId: number | null;
  },
  pendingString: string
): TeamMember {
  return {
    value: `${id || ""}`,
    label: `${name || email || ""}${!username ? ` (${pendingString})` : ""}`,
    avatar,
    email,
    defaultScheduleId,
  };
}

// Members of org sub-teams are always assignable; elsewhere members who have not set a username yet are not.
export function isAssignableMember(member: { username: string | null }, isOrgTeamEvent: boolean): boolean {
  return isOrgTeamEvent || !!member.username;
}

export function buildHostsForAllMembers({
  teamMembers,
  currentHosts,
  isFixed,
  groupId,
}: {
  teamMembers: TeamMember[];
  currentHosts: Host[];
  isFixed: boolean;
  groupId: string | null;
}): Host[] {
  const hostsByUserId = new Map(currentHosts.map((host) => [host.userId, host]));

  return teamMembers.map((teamMember) => {
    const userId = parseInt(teamMember.value, 10);
    const host = hostsByUserId.get(userId);
    return {
      isFixed,
      userId,
      priority: host?.priority ?? 2,
      weight: host?.weight ?? 100,
      scheduleId: host?.scheduleId || teamMember.defaultScheduleId,
      groupId: host?.groupId || groupId,
    };
  });
}

// Hosts rebuilt from select options carry no scheduleId/groupId, so existing hosts must keep theirs.
export function mergeHostsPreservingMeta(changed: Host[], existing: Host[]): Host[] {
  const existingByUserId = new Map(existing.map((host) => [host.userId, host]));

  return changed.map((newValue) => {
    const existingHost = existingByUserId.get(newValue.userId);
    return existingHost
      ? { ...newValue, scheduleId: existingHost.scheduleId, groupId: existingHost.groupId }
      : newValue;
  });
}

export function replaceHostsOfKind({
  all,
  changed,
  isFixed,
}: {
  all: Host[];
  changed: Host[];
  isFixed: boolean;
}): Host[] {
  const otherKind = all.filter((host) => host.isFixed !== isFixed);
  return [...otherKind, ...mergeHostsPreservingMeta(changed, all)];
}

export function removeFixedHosts(hosts: Host[]): Host[] {
  return hosts.filter((host) => !host.isFixed).sort((a, b) => sortHosts(a, b, false));
}

export function sortRoundRobinHosts(hosts: Host[], isRRWeightsEnabled: boolean): Host[] {
  const fixedHosts = hosts.filter((host) => host.isFixed);
  const rrHosts = hosts.filter((host) => !host.isFixed).sort((a, b) => sortHosts(a, b, isRRWeightsEnabled));
  return [...fixedHosts, ...rrHosts];
}

export function addHostGroup({
  hosts,
  hostGroups,
  newId,
}: {
  hosts: Host[];
  hostGroups: HostGroup[];
  newId: () => string;
}): { hosts: Host[]; hostGroups: HostGroup[] } {
  const hasRoundRobinHosts = hosts.some((host) => !host.isFixed);

  if (hostGroups.length === 0 && hasRoundRobinHosts) {
    const firstGroup = { id: newId(), name: "" };
    const secondGroup = { id: newId(), name: "" };
    return {
      hostGroups: [firstGroup, secondGroup],
      hosts: hosts.map((host) =>
        !host.isFixed && !host.groupId ? { ...host, groupId: firstGroup.id } : host
      ),
    };
  }

  return { hosts, hostGroups: [...hostGroups, { id: newId(), name: "" }] };
}

export function removeHostGroup({
  hosts,
  hostGroups,
  groupId,
}: {
  hosts: Host[];
  hostGroups: HostGroup[];
  groupId: string;
}): { hosts: Host[]; hostGroups: HostGroup[] } {
  return {
    hostGroups: hostGroups.filter((group) => group.id !== groupId),
    hosts: hosts.filter((host) => host.groupId !== groupId),
  };
}

export function mapMemberToChildrenOption(
  member: EventTypeSetupProps["teamMembers"][number],
  slug: string,
  pendingString: string
): ChildrenEventType & { value: string; label: string } {
  return {
    slug,
    hidden: false,
    created: false,
    owner: {
      id: member.id,
      name: member.name ?? "",
      email: member.email,
      username: member.username ?? "",
      membership: member.membership,
      eventTypeSlugs: member.eventTypes ?? [],
      avatar: member.avatar,
      profile: member.profile,
    },
    value: `${member.id ?? ""}`,
    label: `${member.name || member.email || ""}${!member.username ? ` (${pendingString})` : ""}`,
  };
}
