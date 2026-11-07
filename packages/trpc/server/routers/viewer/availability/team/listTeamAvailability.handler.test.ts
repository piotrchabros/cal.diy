import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcSessionUser } from "../../../../types";

const { prismaMock, mockEnrichUsers } = vi.hoisted(() => ({
  prismaMock: {
    membership: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    schedule: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockEnrichUsers: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prismaMock, prisma: prismaMock }));

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    enrichUsersWithTheirProfileExcludingOrgMetadata = mockEnrichUsers;
  },
}));

import { listTeamAvailabilityHandler } from "./listTeamAvailability.handler";

const OWN_TEAM_ID = 10;
const OTHER_ORG_TEAM_ID = 99;

const ctx = { user: { id: 1, organizationId: null } as unknown as NonNullable<TrpcSessionUser> };
const baseInput = {
  limit: 10,
  startDate: "2026-01-01",
  endDate: "2026-01-07",
  loggedInUsersTz: "UTC",
};

const queriedTeamIds = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map(([args]) => args?.where?.teamId);

describe("listTeamAvailabilityHandler cross-org isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.membership.findMany.mockResolvedValue([]);
    prismaMock.membership.count.mockResolvedValue(0);
    prismaMock.membership.findFirst.mockResolvedValue({ id: 1 });
    mockEnrichUsers.mockResolvedValue([]);
  });

  it("returns no rows and never queries members of a team the caller does not belong to", async () => {
    prismaMock.membership.findUnique.mockResolvedValue(null);

    const result = await listTeamAvailabilityHandler({
      ctx,
      input: { ...baseInput, teamId: OTHER_ORG_TEAM_ID },
    });

    expect(prismaMock.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_teamId: { userId: 1, teamId: OTHER_ORG_TEAM_ID } },
    });
    expect(result.rows).toEqual([]);
    expect(result.meta.totalRowCount).toBe(0);
    expect(prismaMock.membership.count).not.toHaveBeenCalled();
    expect(prismaMock.membership.findMany).not.toHaveBeenCalled();
  });

  it("queries the team's members when the caller is a member", async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ id: 5 });
    prismaMock.membership.count.mockResolvedValue(1);

    await listTeamAvailabilityHandler({ ctx, input: { ...baseInput, teamId: OWN_TEAM_ID } });

    expect(queriedTeamIds(prismaMock.membership.count)).toEqual([OWN_TEAM_ID]);
    expect(queriedTeamIds(prismaMock.membership.findMany)).toEqual([{ in: [OWN_TEAM_ID] }]);
  });
});
