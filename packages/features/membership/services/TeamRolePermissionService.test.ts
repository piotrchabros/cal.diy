import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamRolePermissionService } from "./TeamRolePermissionService";

vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

describe("TeamRolePermissionService", () => {
  let findTeamIdsByAcceptedRole: ReturnType<typeof vi.fn>;
  let service: TeamRolePermissionService;

  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    findTeamIdsByAcceptedRole = vi.fn();
    service = new TeamRolePermissionService({
      findTeamIdsByAcceptedRole,
    } as unknown as MembershipRepository);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores the BlueBee parent organization while organizations are off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    findTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(
      service.checkPermission({ userId: 1, teamId: 7, fallbackRoles: [MembershipRole.ADMIN] })
    ).resolves.toBe(false);
    await service.getTeamIdsWithPermission({ userId: 1, fallbackRoles: [MembershipRole.ADMIN] });

    for (const [args] of findTeamIdsByAcceptedRole.mock.calls) {
      expect(args.parentRoles).toEqual([]);
    }
  });

  describe("checkPermission", () => {
    it("grants when the team matches an accepted role or a parent org admin/owner role", async () => {
      findTeamIdsByAcceptedRole.mockResolvedValue([7]);

      const result = await service.checkPermission({
        userId: 1,
        teamId: 7,
        permission: "eventType.read",
        fallbackRoles: [MembershipRole.MEMBER],
      });

      expect(result).toBe(true);
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith({
        userId: 1,
        teamId: 7,
        teamRoles: [MembershipRole.MEMBER],
        parentRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
      });
    });

    it("denies when no accepted membership matches", async () => {
      findTeamIdsByAcceptedRole.mockResolvedValue([]);

      await expect(
        service.checkPermission({ userId: 1, teamId: 7, fallbackRoles: [MembershipRole.ADMIN] })
      ).resolves.toBe(false);
    });
  });

  describe("getTeamIdsWithPermission", () => {
    it("returns every team where the user holds a fallback role or administers the parent org", async () => {
      findTeamIdsByAcceptedRole.mockResolvedValue([3, 4]);

      const result = await service.getTeamIdsWithPermission({
        userId: 2,
        permission: "booking.read",
        fallbackRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
      });

      expect(result).toEqual([3, 4]);
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith({
        userId: 2,
        teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
        parentRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
        includeOrganizations: true,
      });
    });

    it("leaves organizations out while organizations are off", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      findTeamIdsByAcceptedRole.mockResolvedValue([]);

      await service.getTeamIdsWithPermission({ userId: 2, fallbackRoles: [MembershipRole.ADMIN] });

      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(
        expect.objectContaining({ includeOrganizations: false, parentRoles: [] })
      );
    });
  });
});
