import type { PrismaBookingReportRepository } from "@calcom/features/bookingReport/repositories/PrismaBookingReportRepository";
import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { TeamRolePermissionService } from "@calcom/features/membership/services/TeamRolePermissionService";
import type { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchlistRepository } from "../repository/WatchlistRepository";
import { OrganizationWatchlistOperationsService } from "./OrganizationWatchlistOperationsService";
import { OrganizationWatchlistQueryService } from "./OrganizationWatchlistQueryService";

vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

describe("organization watchlist permissions (real role check, no stub)", () => {
  const findTeamIdsByAcceptedRole = vi.fn();
  const permissionCheckService = new TeamRolePermissionService({
    findTeamIdsByAcceptedRole,
  } as unknown as MembershipRepository);
  const watchlistRepo = {
    findOrgAndGlobalEntries: vi.fn().mockResolvedValue({ rows: [], count: 0 }),
    deleteEntry: vi.fn().mockResolvedValue(undefined),
  };

  const queryService = new OrganizationWatchlistQueryService({
    watchlistRepo: watchlistRepo as unknown as WatchlistRepository,
    userRepo: { findUsersByIds: vi.fn().mockResolvedValue([]) } as unknown as UserRepository,
    permissionCheckService,
  });
  const operationsService = new OrganizationWatchlistOperationsService({
    watchlistRepo: watchlistRepo as unknown as WatchlistRepository,
    bookingReportRepo: {} as PrismaBookingReportRepository,
    permissionCheckService,
    organizationId: 7,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to list entries to a user without an accepted org admin/owner role", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(
      queryService.listWatchlistEntries({ organizationId: 7, userId: 1, limit: 10, offset: 0 })
    ).rejects.toMatchObject({ message: "You are not authorized to view watchlist entries" });
    expect(watchlistRepo.findOrgAndGlobalEntries).not.toHaveBeenCalled();
    expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        teamId: 7,
        teamRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
      })
    );
  });

  it("lists entries for an accepted org admin/owner", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([7]);

    await queryService.listWatchlistEntries({ organizationId: 7, userId: 1, limit: 10, offset: 0 });

    expect(watchlistRepo.findOrgAndGlobalEntries).toHaveBeenCalled();
  });

  it("refuses to delete entries without an accepted org admin/owner role", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(operationsService.deleteWatchlistEntry({ entryId: "e1", userId: 1 })).rejects.toMatchObject({
      message: "You are not authorized to delete watchlist entries",
    });
    expect(watchlistRepo.deleteEntry).not.toHaveBeenCalled();
  });

  it("deletes entries for an accepted org admin/owner", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([7]);

    await operationsService.deleteWatchlistEntry({ entryId: "e1", userId: 1 });

    expect(watchlistRepo.deleteEntry).toHaveBeenCalledWith("e1", 1);
  });
});
