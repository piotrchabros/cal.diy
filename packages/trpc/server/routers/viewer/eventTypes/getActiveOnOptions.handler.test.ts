import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveOnOptions } from "./getActiveOnOptions.handler";

const { mockFindAllByUpIdIncludeMinimalEventTypes, mockFindTeamIdsByAcceptedRole } = vi.hoisted(() => ({
  mockFindAllByUpIdIncludeMinimalEventTypes: vi.fn(),
  mockFindTeamIdsByAcceptedRole: vi.fn(),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({ checkRateLimitAndThrowError: vi.fn() }));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    static findAllByUpIdIncludeMinimalEventTypes = mockFindAllByUpIdIncludeMinimalEventTypes;
    findTeamIdsByAcceptedRole = mockFindTeamIdsByAcceptedRole;
  },
}));

vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: {
    findByUpIdWithAuth: vi.fn().mockResolvedValue({ username: "u", name: "User", organization: null }),
  },
}));

vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    findAllByUpIdWithMinimalData = vi.fn().mockResolvedValue([]);
  },
}));

const teamWithEventTypes = {
  team: {
    id: 10,
    name: "Team",
    parentId: null,
    isOrganization: false,
    metadata: {},
    eventTypes: [
      { id: 1, title: "Round robin", userId: null, schedulingType: SchedulingType.ROUND_ROBIN, metadata: {} },
      { id: 2, title: "Managed", userId: null, schedulingType: SchedulingType.MANAGED, metadata: {} },
    ],
  },
};

const run = () =>
  getActiveOnOptions({
    ctx: {
      user: { id: 1, profile: { upId: "usr-1" } },
      prisma: {} as PrismaClient,
    } as unknown as Parameters<typeof getActiveOnOptions>[0]["ctx"],
    input: { teamId: 10, isOrg: false },
  });

describe("getActiveOnOptions team event type update rights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAllByUpIdIncludeMinimalEventTypes.mockResolvedValue([teamWithEventTypes]);
  });

  it("includes managed event types for an accepted team admin/owner", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([10]);

    const { eventTypeOptions } = await run();

    expect(eventTypeOptions.map((option) => option.value)).toEqual(["1", "2"]);
    expect(mockFindTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER] })
    );
  });

  it("hides managed event types from a member without an admin/owner role", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([]);

    const { eventTypeOptions } = await run();

    expect(eventTypeOptions.map((option) => option.value)).toEqual(["1"]);
  });
});
