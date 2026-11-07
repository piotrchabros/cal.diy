import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAdminForUser } from "./outOfOffice.utils";

const { mockFindTeamIdsByAcceptedRole, mockMembershipFindFirst } = vi.hoisted(() => ({
  mockFindTeamIdsByAcceptedRole: vi.fn(),
  mockMembershipFindFirst: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: { membership: { findFirst: mockMembershipFindFirst } },
  prisma: { membership: { findFirst: mockMembershipFindFirst } },
}));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    findTeamIdsByAcceptedRole = mockFindTeamIdsByAcceptedRole;
  },
}));

describe("isAdminForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is false when the caller administers no team", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(isAdminForUser(1, 2)).resolves.toBe(false);
    expect(mockMembershipFindFirst).not.toHaveBeenCalled();
    expect(mockFindTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER] })
    );
  });

  it("is true when the member has an accepted membership in a team the caller administers", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([10]);
    mockMembershipFindFirst.mockResolvedValue({ id: 5 });

    await expect(isAdminForUser(1, 2)).resolves.toBe(true);
    expect(mockMembershipFindFirst).toHaveBeenCalledWith({
      where: { userId: 2, accepted: true, teamId: { in: [10] } },
      select: { id: true },
    });
  });

  it("is false when the member is not in any team the caller administers", async () => {
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([10]);
    mockMembershipFindFirst.mockResolvedValue(null);

    await expect(isAdminForUser(1, 2)).resolves.toBe(false);
  });
});
