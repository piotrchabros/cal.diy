import type { PrismaClient } from "@calcom/prisma";
import type { UserProfile } from "@calcom/types/UserProfile";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsersFromEvent } from "./getPublicEvent";

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
