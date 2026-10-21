import type { Host, TeamMember } from "@calcom/features/eventtypes/lib/types";
import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import {
  addHostGroup,
  buildHostsForAllMembers,
  isAssignableMember,
  mapMemberToChildrenOption,
  mapUserToValue,
  mergeHostsPreservingMeta,
  removeFixedHosts,
  removeHostGroup,
  replaceHostsOfKind,
  sortRoundRobinHosts,
} from "./assignmentHosts";

const makeHost = (overrides: Partial<Host> & Pick<Host, "userId">): Host => ({
  isFixed: false,
  priority: 2,
  weight: 100,
  scheduleId: null,
  groupId: null,
  ...overrides,
});

const makeMember = (id: number, defaultScheduleId: number | null = null): TeamMember => ({
  value: `${id}`,
  label: `User ${id}`,
  avatar: "",
  email: `user${id}@example.com`,
  defaultScheduleId,
});

const makeIdGenerator = (): (() => string) => {
  let counter = 0;
  return (): string => `group-${++counter}`;
};

describe("mapUserToValue", () => {
  const baseUser = {
    id: 7,
    name: "Alice",
    username: "alice",
    avatar: "avatar.png",
    email: "alice@example.com",
    defaultScheduleId: 3,
  };

  it("uses the id as value and the name as label for members with a username", () => {
    expect(mapUserToValue(baseUser, "pending")).toEqual({
      value: "7",
      label: "Alice",
      avatar: "avatar.png",
      email: "alice@example.com",
      defaultScheduleId: 3,
    });
  });

  it("marks members without a username as pending", () => {
    expect(mapUserToValue({ ...baseUser, username: null }, "pending").label).toBe("Alice (pending)");
  });

  it("falls back to the email when the name is missing", () => {
    expect(mapUserToValue({ ...baseUser, name: null, username: null }, "pending").label).toBe(
      "alice@example.com (pending)"
    );
  });

  it("uses an empty value when the id is missing", () => {
    expect(mapUserToValue({ ...baseUser, id: null }, "pending").value).toBe("");
  });
});

describe("isAssignableMember", () => {
  it("allows any member of an org team event", () => {
    expect(isAssignableMember({ username: null }, true)).toBe(true);
  });

  it("requires a username outside of org team events", () => {
    expect(isAssignableMember({ username: null }, false)).toBe(false);
    expect(isAssignableMember({ username: "" }, false)).toBe(false);
    expect(isAssignableMember({ username: "bob" }, false)).toBe(true);
  });
});

describe("buildHostsForAllMembers", () => {
  it("keeps existing priority, weight, scheduleId and groupId", () => {
    const currentHosts = [makeHost({ userId: 1, priority: 4, weight: 50, scheduleId: 9, groupId: "g1" })];

    const result = buildHostsForAllMembers({
      teamMembers: [makeMember(1, 5)],
      currentHosts,
      isFixed: true,
      groupId: "g-default",
    });

    expect(result).toEqual([
      { isFixed: true, userId: 1, priority: 4, weight: 50, scheduleId: 9, groupId: "g1" },
    ]);
  });

  it("fills defaults for members that are not hosts yet", () => {
    const result = buildHostsForAllMembers({
      teamMembers: [makeMember(2, 5)],
      currentHosts: [],
      isFixed: false,
      groupId: "g-default",
    });

    expect(result).toEqual([
      { isFixed: false, userId: 2, priority: 2, weight: 100, scheduleId: 5, groupId: "g-default" },
    ]);
  });

  it("falls back to the default schedule when the existing host has none", () => {
    const result = buildHostsForAllMembers({
      teamMembers: [makeMember(1, 5)],
      currentHosts: [makeHost({ userId: 1, scheduleId: null })],
      isFixed: false,
      groupId: null,
    });

    expect(result[0].scheduleId).toBe(5);
    expect(result[0].groupId).toBeNull();
  });

  it("applies isFixed to every resulting host", () => {
    const result = buildHostsForAllMembers({
      teamMembers: [makeMember(1), makeMember(2)],
      currentHosts: [makeHost({ userId: 1, isFixed: false })],
      isFixed: true,
      groupId: null,
    });

    expect(result.map((host) => host.isFixed)).toEqual([true, true]);
  });
});

describe("mergeHostsPreservingMeta", () => {
  it("keeps scheduleId and groupId of existing hosts", () => {
    const existing = [makeHost({ userId: 1, scheduleId: 8, groupId: "g1" })];
    const changed = [makeHost({ userId: 1, priority: 0, weight: 10 })];

    expect(mergeHostsPreservingMeta(changed, existing)).toEqual([
      makeHost({ userId: 1, priority: 0, weight: 10, scheduleId: 8, groupId: "g1" }),
    ]);
  });

  it("returns new hosts unchanged", () => {
    const changed = [makeHost({ userId: 2, scheduleId: 4, groupId: "g2" })];

    expect(mergeHostsPreservingMeta(changed, [makeHost({ userId: 1 })])).toEqual(changed);
  });
});

describe("replaceHostsOfKind", () => {
  it("keeps hosts of the other kind and replaces hosts of the given kind", () => {
    const fixedHost = makeHost({ userId: 1, isFixed: true });
    const oldRoundRobin = makeHost({ userId: 2, scheduleId: 6, groupId: "g1" });
    const newRoundRobin = makeHost({ userId: 3 });
    const updatedOldRoundRobin = makeHost({ userId: 2, priority: 1 });

    const result = replaceHostsOfKind({
      all: [fixedHost, oldRoundRobin],
      changed: [updatedOldRoundRobin, newRoundRobin],
      isFixed: false,
    });

    expect(result).toEqual([
      fixedHost,
      { ...updatedOldRoundRobin, scheduleId: 6, groupId: "g1" },
      newRoundRobin,
    ]);
  });

  it("removes all hosts of the given kind when nothing changed", () => {
    const fixedHost = makeHost({ userId: 1, isFixed: true });
    const roundRobin = makeHost({ userId: 2 });

    expect(replaceHostsOfKind({ all: [fixedHost, roundRobin], changed: [], isFixed: false })).toEqual([
      fixedHost,
    ]);
  });
});

describe("removeFixedHosts", () => {
  it("drops fixed hosts and sorts the rest by priority descending", () => {
    const hosts = [
      makeHost({ userId: 1, isFixed: true, priority: 4 }),
      makeHost({ userId: 2, priority: 1 }),
      makeHost({ userId: 3, priority: 3 }),
      makeHost({ userId: 4, priority: 2 }),
    ];

    expect(removeFixedHosts(hosts).map((host) => host.userId)).toEqual([3, 4, 2]);
  });
});

describe("sortRoundRobinHosts", () => {
  const hosts = [
    makeHost({ userId: 1, priority: 1, weight: 300 }),
    makeHost({ userId: 2, isFixed: true, priority: 0 }),
    makeHost({ userId: 3, priority: 3, weight: 100 }),
    makeHost({ userId: 4, priority: 2, weight: 200 }),
    makeHost({ userId: 5, isFixed: true, priority: 4 }),
  ];

  it("puts fixed hosts first and sorts round-robin hosts by priority when weights are off", () => {
    expect(sortRoundRobinHosts(hosts, false).map((host) => host.userId)).toEqual([2, 5, 3, 4, 1]);
  });

  it("sorts round-robin hosts by weight, then priority, when weights are on", () => {
    expect(sortRoundRobinHosts(hosts, true).map((host) => host.userId)).toEqual([2, 5, 1, 4, 3]);
  });

  it("falls back to priority for hosts with equal weight when weights are on", () => {
    const sameWeight = [makeHost({ userId: 1, priority: 1 }), makeHost({ userId: 2, priority: 3 })];

    expect(sortRoundRobinHosts(sameWeight, true).map((host) => host.userId)).toEqual([2, 1]);
  });
});

describe("addHostGroup", () => {
  it("creates two groups and moves ungrouped round-robin hosts to the first on the first add", () => {
    const fixedHost = makeHost({ userId: 1, isFixed: true });
    const ungrouped = makeHost({ userId: 2 });
    const alreadyGrouped = makeHost({ userId: 3, groupId: "existing" });

    const result = addHostGroup({
      hosts: [fixedHost, ungrouped, alreadyGrouped],
      hostGroups: [],
      newId: makeIdGenerator(),
    });

    expect(result.hostGroups).toEqual([
      { id: "group-1", name: "" },
      { id: "group-2", name: "" },
    ]);
    expect(result.hosts).toEqual([fixedHost, { ...ungrouped, groupId: "group-1" }, alreadyGrouped]);
  });

  it("creates a single group on the first add when there are no hosts", () => {
    const result = addHostGroup({ hosts: [], hostGroups: [], newId: makeIdGenerator() });

    expect(result).toEqual({ hosts: [], hostGroups: [{ id: "group-1", name: "" }] });
  });

  it("creates a single group on the first add when there are only fixed hosts", () => {
    const hosts = [makeHost({ userId: 1, isFixed: true })];

    const result = addHostGroup({ hosts, hostGroups: [], newId: makeIdGenerator() });

    expect(result).toEqual({ hosts, hostGroups: [{ id: "group-1", name: "" }] });
  });

  it("appends a single group on later adds without touching hosts", () => {
    const hosts = [makeHost({ userId: 1 })];

    const result = addHostGroup({
      hosts,
      hostGroups: [{ id: "existing", name: "A" }],
      newId: makeIdGenerator(),
    });

    expect(result).toEqual({
      hosts,
      hostGroups: [
        { id: "existing", name: "A" },
        { id: "group-1", name: "" },
      ],
    });
  });
});

describe("removeHostGroup", () => {
  it("drops the group and the hosts that belong to it", () => {
    const keptHost = makeHost({ userId: 1, groupId: "g2" });
    const ungroupedHost = makeHost({ userId: 3 });

    const result = removeHostGroup({
      hosts: [keptHost, makeHost({ userId: 2, groupId: "g1" }), ungroupedHost],
      hostGroups: [
        { id: "g1", name: "One" },
        { id: "g2", name: "Two" },
      ],
      groupId: "g1",
    });

    expect(result).toEqual({
      hosts: [keptHost, ungroupedHost],
      hostGroups: [{ id: "g2", name: "Two" }],
    });
  });
});

describe("mapMemberToChildrenOption", () => {
  const member: Parameters<typeof mapMemberToChildrenOption>[0] = {
    id: 11,
    name: "Carol",
    email: "carol@example.com",
    username: "carol",
    avatar: "carol.png",
    avatarUrl: null,
    profileId: null,
    nonProfileUsername: "carol",
    timeZone: "UTC",
    locale: "en",
    defaultScheduleId: null,
    isPlatformManaged: false,
    membership: MembershipRole.MEMBER,
    eventTypes: ["30min", "60min"],
    profile: {
      id: null,
      upId: "usr-11",
      username: "carol",
      organizationId: null,
      organization: null,
    },
  };

  it("maps the member to an unmanaged-yet children event type option", () => {
    expect(mapMemberToChildrenOption(member, "managed-slug", "pending")).toEqual({
      slug: "managed-slug",
      hidden: false,
      created: false,
      owner: {
        id: 11,
        name: "Carol",
        email: "carol@example.com",
        username: "carol",
        membership: MembershipRole.MEMBER,
        eventTypeSlugs: ["30min", "60min"],
        avatar: "carol.png",
        profile: member.profile,
      },
      value: "11",
      label: "Carol",
    });
  });

  it("marks members without a username as pending and defaults missing fields", () => {
    const result = mapMemberToChildrenOption(
      { ...member, name: null, username: null, eventTypes: [] },
      "managed-slug",
      "pending"
    );

    expect(result.label).toBe("carol@example.com (pending)");
    expect(result.owner.name).toBe("");
    expect(result.owner.username).toBe("");
    expect(result.owner.eventTypeSlugs).toEqual([]);
  });
});
