import type { PrismaClient } from "@calcom/prisma";
import type { UserProfile } from "@calcom/types/UserProfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicEvent, getUsersFromEvent } from "./getPublicEvent";

vi.mock("@calcom/prisma", () => ({
  PrismaClient: vi.fn(),
  default: {},
}));

const getBaseUrl = vi.fn(async ({ organizationId }: { organizationId: number | null | undefined }) =>
  organizationId ? `https://org${organizationId}.example` : "https://app.example"
);

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl }),
}));

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    async enrichUsersWithTheirProfiles<T>(users: T[]) {
      return users.map((user) => ({ ...user, profile: buildProfile(null) }));
    }
    async enrichUserWithItsProfile<T>({ user }: { user: T }) {
      return { ...user, profile: buildProfile(null) };
    }
  },
}));

const { checkPermission } = vi.hoisted(() => ({
  checkPermission: vi.fn(),
}));

vi.mock("@calcom/features/membership/services/TeamRolePermissionService", () => ({
  TeamRolePermissionService: class {
    checkPermission = checkPermission;
  },
}));

type GetUsersFromEventInput = Parameters<typeof getUsersFromEvent>[0];

const prisma = {} as unknown as PrismaClient;

function buildProfile(organizationId: number | null): UserProfile {
  if (organizationId === null) {
    return { id: null, upId: "usr-1", username: "user", organizationId: null, organization: null };
  }
  return {
    id: organizationId,
    upId: String(organizationId),
    username: "user",
    organizationId,
    organization: {
      id: organizationId,
      name: `Org ${organizationId}`,
      slug: `org${organizationId}`,
      calVideoLogo: null,
      bannerUrl: null,
      requestedSlug: null,
    },
  };
}

function buildHost(username: string, organizationId: number | null) {
  return {
    user: {
      username,
      name: username,
      weekStart: "Monday",
      avatarUrl: null,
      profile: buildProfile(organizationId),
    },
  };
}

function buildEvent(overrides: Record<string, unknown>): GetUsersFromEventInput {
  return {
    id: 1,
    team: null,
    owner: null,
    hosts: [],
    subsetOfHosts: [],
    ...overrides,
  } as unknown as GetUsersFromEventInput;
}

describe("getUsersFromEvent", () => {
  beforeEach(() => {
    getBaseUrl.mockClear();
  });

  it("resolves one booker URL per team host by organization id, in host order", async () => {
    const event = buildEvent({
      team: { id: 10 },
      hosts: [buildHost("alice", 5), buildHost("bob", null), buildHost("carol", 7)],
    });

    const users = await getUsersFromEvent(event, prisma);

    expect(getBaseUrl).toHaveBeenCalledTimes(3);
    expect(getBaseUrl.mock.calls.map(([arg]) => arg)).toEqual([
      { organizationId: 5 },
      { organizationId: null },
      { organizationId: 7 },
    ]);
    expect(users?.map((user) => [user.username, user.bookerUrl])).toEqual([
      ["alice", "https://org5.example"],
      ["bob", "https://app.example"],
      ["carol", "https://org7.example"],
    ]);
  });

  it("skips team hosts without a username", async () => {
    const event = buildEvent({
      team: { id: 10 },
      hosts: [buildHost("alice", 5), { user: { ...buildHost("", 9).user, username: null } }],
    });

    const users = await getUsersFromEvent(event, prisma);

    expect(getBaseUrl).toHaveBeenCalledTimes(1);
    expect(users?.map((user) => user.username)).toEqual(["alice"]);
  });

  it("resolves the owner's booker URL from the owner's organization id", async () => {
    const event = buildEvent({
      owner: buildHost("owner", 42).user,
    });

    const users = await getUsersFromEvent(event, prisma);

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: 42 });
    expect(users).toHaveLength(1);
    expect(users?.[0]).toMatchObject({
      username: "owner",
      organizationId: 42,
      bookerUrl: "https://org42.example",
    });
  });

  it("falls back to the app URL for an owner without an organization", async () => {
    const event = buildEvent({
      owner: buildHost("owner", null).user,
    });

    const users = await getUsersFromEvent(event, prisma);

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: null });
    expect(users?.[0].bookerUrl).toBe("https://app.example");
  });

  it("returns null when a non-team event has no owner", async () => {
    const users = await getUsersFromEvent(buildEvent({}), prisma);

    expect(users).toBeNull();
    expect(getBaseUrl).not.toHaveBeenCalled();
  });
});

describe("getPublicEvent organization filters without an org slug", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function getFirstWhere(isTeamEvent: boolean) {
    const findFirst = vi.fn().mockResolvedValue(null);
    const fakePrisma = { eventType: { findFirst } } as unknown as PrismaClient;

    const event = await getPublicEvent("alice", "30min", isTeamEvent, null, fakePrisma, false);

    expect(event).toBeNull();
    return findFirst.mock.calls[0][0].where;
  }

  it("requires the user to have no profiles when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    const where = await getFirstWhere(false);

    expect(where).toEqual({
      slug: "30min",
      users: { some: { username: "alice", profiles: { none: {} } } },
      team: null,
    });
  });

  it("ignores user profiles when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const where = await getFirstWhere(false);

    expect(where).toEqual({
      slug: "30min",
      users: { some: { username: "alice" } },
      team: null,
    });
  });

  it("requires the team to have no parent when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    const where = await getFirstWhere(true);

    expect(where).toEqual({ slug: "30min", team: { slug: "alice", parent: null } });
  });

  it("ignores the team parent when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const where = await getFirstWhere(true);

    expect(where).toEqual({ slug: "30min", team: { slug: "alice" } });
  });
});

describe("getPublicEvent entity of a team under the organization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function getTeamEvent() {
    const team = {
      parentId: 1,
      metadata: {},
      brandColor: null,
      darkBrandColor: null,
      slug: "sales",
      name: "Sales",
      logoUrl: null,
      theme: null,
      hideTeamProfileLink: false,
      isPrivate: false,
      parent: {
        slug: "bluebee",
        name: "BlueBee",
        bannerUrl: null,
        logoUrl: null,
        organizationSettings: null,
      },
    };
    const findFirst = vi.fn().mockResolvedValue({
      id: 1,
      slug: "30min",
      length: 30,
      teamId: 2,
      team,
      owner: null,
      hosts: [buildHost("alice", null)],
      metadata: {},
      description: null,
      customInputs: [],
      locations: [],
      bookingFields: [],
      recurringEvent: null,
      schedule: null,
      isInstantEvent: false,
      instantMeetingSchedule: null,
      parent: null,
    });
    const fakePrisma = { eventType: { findFirst } } as unknown as PrismaClient;

    const event = await getPublicEvent("sales", "30min", true, null, fakePrisma, false);

    return event?.entity;
  }

  it("names the entity after the organization when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await getTeamEvent()).toMatchObject({ name: "BlueBee", teamSlug: "sales" });
  });

  it("names the entity after the team when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await getTeamEvent()).toMatchObject({ name: "Sales", teamSlug: "sales" });
  });
});

describe("getPublicEvent private team members", () => {
  afterEach(() => {
    checkPermission.mockReset();
  });

  async function getTeamEventUsers({
    isPrivate,
    currentUserId,
  }: {
    isPrivate: boolean;
    currentUserId?: number;
  }) {
    const team = {
      parentId: 1,
      metadata: {},
      brandColor: null,
      darkBrandColor: null,
      slug: "sales",
      name: "Sales",
      logoUrl: null,
      theme: null,
      hideTeamProfileLink: false,
      isPrivate,
      parent: {
        slug: "bluebee",
        name: "BlueBee",
        bannerUrl: null,
        logoUrl: null,
        organizationSettings: null,
      },
    };
    const findFirst = vi.fn().mockResolvedValue({
      id: 1,
      slug: "30min",
      length: 30,
      teamId: 2,
      team,
      owner: null,
      hosts: [buildHost("alice", null)],
      metadata: {},
      description: null,
      customInputs: [],
      locations: [],
      bookingFields: [],
      recurringEvent: null,
      schedule: null,
      isInstantEvent: false,
      instantMeetingSchedule: null,
      parent: null,
    });
    const fakePrisma = { eventType: { findFirst } } as unknown as PrismaClient;

    const event = await getPublicEvent("sales", "30min", true, null, fakePrisma, false, currentUserId);

    return event?.subsetOfUsers;
  }

  it("hides the members of a private team from an anonymous visitor", async () => {
    expect(await getTeamEventUsers({ isPrivate: true })).toEqual([]);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it("shows the members of a private team to a user with team.read", async () => {
    checkPermission.mockResolvedValue(true);

    expect(await getTeamEventUsers({ isPrivate: true, currentUserId: 5 })).toHaveLength(1);
    expect(checkPermission).toHaveBeenCalledTimes(1);
    expect(checkPermission).toHaveBeenCalledWith({
      userId: 5,
      teamId: 2,
      permission: "team.read",
      fallbackRoles: ["ADMIN", "OWNER"],
    });
  });

  it("hides the members of a private team from a user without team.read", async () => {
    checkPermission.mockResolvedValue(false);

    expect(await getTeamEventUsers({ isPrivate: true, currentUserId: 5 })).toEqual([]);
  });

  it("shows the members of a public team without checking permissions", async () => {
    expect(await getTeamEventUsers({ isPrivate: false, currentUserId: 5 })).toHaveLength(1);
    expect(checkPermission).not.toHaveBeenCalled();
  });
});
