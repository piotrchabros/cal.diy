import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindByUpIdWithAuth, mockFindMemberships, mockGetTeamIdsWithPermission } = vi.hoisted(() => ({
  mockFindByUpIdWithAuth: vi.fn(),
  mockFindMemberships: vi.fn(),
  mockGetTeamIdsWithPermission: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: {} }));
vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: { findByUpIdWithAuth: mockFindByUpIdWithAuth },
}));
vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: { findAllByUpIdIncludeTeamWithMembersAndEventTypes: mockFindMemberships },
}));
vi.mock("@calcom/features/membership/services/TeamRolePermissionService", () => ({
  TeamRolePermissionService: class {
    getTeamIdsWithPermission = mockGetTeamIdsWithPermission;
  },
}));
vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    async findAllByUpId() {
      return [];
    }
  },
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    async enrichUsersWithTheirProfiles<T>(users: T) {
      return users;
    }
  },
}));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: async () => "https://app.example" }),
}));

import { getEventTypesByViewer } from "./getEventTypesByViewer";

const eventType = (id: number, schedulingType: string) => ({
  id,
  teamId: 2,
  userId: null,
  parentId: null,
  schedulingType,
  position: 0,
  description: null,
  metadata: null,
  hosts: [],
  users: [],
  children: [],
});

const orgMembership = (role: string) => ({
  role,
  team: {
    id: 1,
    name: "BlueBee",
    slug: "bluebee",
    logoUrl: null,
    isOrganization: true,
    parentId: null,
    parent: null,
    metadata: null,
    members: [{}],
    eventTypes: [],
  },
});

const teamMembership = (role: string) => ({
  role,
  team: {
    id: 2,
    name: "Sales",
    slug: "sales",
    logoUrl: null,
    isOrganization: false,
    parentId: 1,
    parent: { logoUrl: null, name: "BlueBee" },
    metadata: null,
    members: [{}],
    eventTypes: [eventType(10, "ROUND_ROBIN"), eventType(11, "MANAGED")],
  },
});

const viewer = { id: 5, profile: { upId: "usr-5" } };

function grantTeamIds({ read, update }: { read: number[]; update: number[] }) {
  mockGetTeamIdsWithPermission.mockImplementation(
    async ({ fallbackRoles }: { fallbackRoles: readonly string[] }) =>
      fallbackRoles.includes("MEMBER") ? read : update
  );
}

async function getTeamGroup(teamId: number | null) {
  const result = await getEventTypesByViewer(viewer);
  return { result, group: result.eventTypeGroups.find((g) => g.teamId === teamId) };
}

describe("getEventTypesByViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByUpIdWithAuth.mockResolvedValue({
      username: "alice",
      name: "Alice",
      avatarUrl: null,
      organizationId: null,
      organization: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks for event type read and update permissions by role", async () => {
    grantTeamIds({ read: [2], update: [] });
    mockFindMemberships.mockResolvedValue([teamMembership("MEMBER")]);

    await getTeamGroup(2);

    expect(mockGetTeamIdsWithPermission).toHaveBeenCalledWith({
      userId: 5,
      permission: "eventType.read",
      fallbackRoles: ["MEMBER", "ADMIN", "OWNER"],
    });
    expect(mockGetTeamIdsWithPermission).toHaveBeenCalledWith({
      userId: 5,
      permission: "eventType.update",
      fallbackRoles: ["ADMIN", "OWNER"],
    });
  });

  it("lets a user with read permission see team event types but hides managed ones", async () => {
    grantTeamIds({ read: [2], update: [] });
    mockFindMemberships.mockResolvedValue([teamMembership("MEMBER")]);

    const { group } = await getTeamGroup(2);

    expect(group?.metadata.readOnly).toBe(false);
    expect(group?.membershipRole).toBe("MEMBER");
    expect(group?.eventTypes.map((e) => e.id)).toEqual([10]);
  });

  it("shows managed event types to a user with update permission", async () => {
    grantTeamIds({ read: [2], update: [2] });
    mockFindMemberships.mockResolvedValue([teamMembership("ADMIN")]);

    const { group } = await getTeamGroup(2);

    expect(group?.metadata.readOnly).toBe(false);
    expect(group?.membershipRole).toBe("ADMIN");
    expect(group?.eventTypes.map((e) => e.id)).toEqual([10, 11]);
  });

  it("marks the team read-only without read permission", async () => {
    grantTeamIds({ read: [], update: [] });
    mockFindMemberships.mockResolvedValue([teamMembership("MEMBER")]);

    const { group } = await getTeamGroup(2);

    expect(group?.metadata.readOnly).toBe(true);
    expect(group?.eventTypes.map((e) => e.id)).toEqual([10]);
  });

  it("upgrades a team member to their organization role when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    grantTeamIds({ read: [1, 2], update: [1, 2] });
    mockFindMemberships.mockResolvedValue([orgMembership("ADMIN"), teamMembership("MEMBER")]);

    const { result, group } = await getTeamGroup(2);

    expect(group?.membershipRole).toBe("ADMIN");
    expect(group?.parentId).toBe(1);
    expect(result.eventTypeGroups.find((g) => g.teamId === 1)).toBeUndefined();
  });

  it("ignores the organization role when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    grantTeamIds({ read: [1, 2], update: [1] });
    mockFindMemberships.mockResolvedValue([orgMembership("ADMIN"), teamMembership("MEMBER")]);

    const { result, group } = await getTeamGroup(2);

    expect(group?.membershipRole).toBe("MEMBER");
    expect(group?.parentId).toBeNull();
    expect(group?.eventTypes.map((e) => e.id)).toEqual([10]);
    expect(result.eventTypeGroups.find((g) => g.teamId === 1)).toBeUndefined();
  });

  it("includes the personal group as editable", async () => {
    grantTeamIds({ read: [], update: [] });
    mockFindMemberships.mockResolvedValue([teamMembership("MEMBER")]);

    const { group } = await getTeamGroup(null);

    expect(group).toBeDefined();
    expect(group?.metadata.readOnly).toBe(false);
  });
});
