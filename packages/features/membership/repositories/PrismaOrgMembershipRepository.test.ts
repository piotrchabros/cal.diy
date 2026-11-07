import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    membership: { findMany: vi.fn(), findFirst: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import { PrismaOrgMembershipRepository } from "./PrismaOrgMembershipRepository";

describe("PrismaOrgMembershipRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.membership.findMany).mockResolvedValue([{ teamId: 10 }] as never);
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("finds admin memberships of top-level teams only", async () => {
      const orgIds = await PrismaOrgMembershipRepository.getOrgIdsWhereAdmin(1);

      expect(orgIds).toEqual([10]);
      expect(prisma.membership.findMany).toHaveBeenCalledWith({
        where: {
          userId: 1,
          role: { in: [MembershipRole.OWNER, MembershipRole.ADMIN] },
          team: { parentId: null },
        },
        select: { teamId: true },
      });
    });

    it("checks the booking host's top-level and sub-team memberships", async () => {
      const isAdmin = await PrismaOrgMembershipRepository.isLoggedInUserOrgAdminOfBookingHost(1, 2);

      expect(isAdmin).toBe(false);
      expect(prisma.membership.findFirst).toHaveBeenNthCalledWith(1, {
        where: { userId: 2, teamId: { in: [10] }, team: { parentId: null } },
        select: { userId: true },
      });
      expect(prisma.membership.findFirst).toHaveBeenNthCalledWith(2, {
        where: { userId: 2, team: { parentId: { in: [10] } } },
      });
    });
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it("finds admin memberships of every non-organization team, ignoring the BlueBee parent", async () => {
      await PrismaOrgMembershipRepository.getOrgIdsWhereAdmin(1);

      expect(prisma.membership.findMany).toHaveBeenCalledWith({
        where: {
          userId: 1,
          role: { in: [MembershipRole.OWNER, MembershipRole.ADMIN] },
          team: { isOrganization: false },
        },
        select: { teamId: true },
      });
    });

    it("grants access when the booking host shares one of those teams", async () => {
      vi.mocked(prisma.membership.findFirst).mockResolvedValueOnce({ userId: 2 } as never);

      const isAdmin = await PrismaOrgMembershipRepository.isLoggedInUserOrgAdminOfBookingHost(1, 2);

      expect(isAdmin).toBe(true);
      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { userId: 2, teamId: { in: [10] }, team: { isOrganization: false } },
        select: { userId: true },
      });
    });

    it("returns false without querying the host when the user administers no team", async () => {
      vi.mocked(prisma.membership.findMany).mockResolvedValue([]);

      const isAdmin = await PrismaOrgMembershipRepository.isLoggedInUserOrgAdminOfBookingHost(1, 2);

      expect(isAdmin).toBe(false);
      expect(prisma.membership.findFirst).not.toHaveBeenCalled();
    });
  });
});
