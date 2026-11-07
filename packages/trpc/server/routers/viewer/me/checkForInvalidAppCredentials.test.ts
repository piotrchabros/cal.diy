import { MembershipRole } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkInvalidAppCredentials } from "./checkForInvalidAppCredentials";

const { mockFindTeamIdsByAcceptedRole, mockCredentialFindMany } = vi.hoisted(() => ({
  mockFindTeamIdsByAcceptedRole: vi.fn(),
  mockCredentialFindMany: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: { credential: { findMany: mockCredentialFindMany } },
  prisma: { credential: { findMany: mockCredentialFindMany } },
}));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    findTeamIdsByAcceptedRole = mockFindTeamIdsByAcceptedRole;
  },
}));

vi.mock("@calcom/app-store/utils", () => ({
  getAppFromSlug: vi.fn(async (slug: string) => ({ name: `App ${slug}` })),
}));

const ctx = { user: { id: 1 } as NonNullable<TrpcSessionUser> };

describe("checkInvalidAppCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialFindMany.mockResolvedValue([{ appId: "zoom" }]);
  });

  it("includes invalid credentials of teams the user administers", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([10, 11]);

    await expect(checkInvalidAppCredentials({ ctx })).resolves.toEqual([{ slug: "zoom", name: "App zoom" }]);
    expect(mockFindTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER] })
    );
    expect(mockCredentialFindMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: 1 }, { teamId: { in: [10, 11] } }], invalid: true },
      select: { appId: true },
    });
  });

  it("checks only the user's own credentials without an admin/owner role", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([]);

    await checkInvalidAppCredentials({ ctx });

    expect(mockCredentialFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: 1 }, { teamId: { in: [] } }], invalid: true } })
    );
  });
});
