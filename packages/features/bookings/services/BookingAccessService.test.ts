import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingRepository } from "../repositories/BookingRepository";
import { BookingAccessService } from "./BookingAccessService";

vi.mock("../repositories/BookingRepository");
vi.mock("@calcom/features/users/repositories/UserRepository");
vi.mock("@calcom/features/membership/repositories/MembershipRepository");

vi.mock("@calcom/prisma", () => ({
  default: {},
  prisma: {},
}));

describe("BookingAccessService", () => {
  let service: BookingAccessService;
  let mockPrismaClient: PrismaClient;
  let mockBookingRepo: {
    findByUidIncludeEventType: ReturnType<typeof vi.fn>;
  };
  let mockUserRepo: {
    getUserOrganizationAndTeams: ReturnType<typeof vi.fn>;
  };
  let mockPermissionCheckService: {
    checkPermission: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrismaClient = {} as PrismaClient;

    mockBookingRepo = {
      findByUidIncludeEventType: vi.fn(),
    };

    mockUserRepo = {
      getUserOrganizationAndTeams: vi.fn(),
    };

    mockPermissionCheckService = {
      checkPermission: vi.fn(),
    };

    vi.mocked(BookingRepository).mockImplementation(function () {
      return mockBookingRepo as any;
    });
    vi.mocked(UserRepository).mockImplementation(function () {
      return mockUserRepo as any;
    });

    service = new BookingAccessService(mockPrismaClient);

    (service as any).permissionCheckService = mockPermissionCheckService;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("doesUserIdHaveAccessToBooking", () => {
    describe("Case 1: Booking Organizer", () => {
      it("should return true when user is the booking organizer", async () => {
        const mockBooking = {
          userId: 123,
          eventType: null,
          attendees: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
        expect(mockBookingRepo.findByUidIncludeEventType).toHaveBeenCalledWith({
          bookingUid: "test-booking-uid",
        });
      });

      it("should return false when user is not the organizer and booking has no team", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(null);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
      });
    });

    describe("Case 2: Booking Host", () => {
      it("should return true when user is a host in eventType.hosts", async () => {
        const mockBooking = {
          userId: 456,
          user: { id: 456, email: "organizer@example.com" },
          eventType: {
            hosts: [
              { userId: 123, user: { email: "host@example.com" } },
              { userId: 789, user: { email: "other-host@example.com" } },
            ],
            users: [],
          },
          attendees: [{ email: "host@example.com" }],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
      });

      it("should return true when user is in eventType.users", async () => {
        const mockBooking = {
          userId: 456,
          user: { id: 456, email: "organizer@example.com" },
          eventType: {
            hosts: [],
            users: [
              { id: 123, email: "user@example.com" },
              { id: 789, email: "other-user@example.com" },
            ],
          },
          attendees: [{ email: "user@example.com" }],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
      });

      it("should return false when user is not a host", async () => {
        const mockBooking = {
          userId: 456,
          user: { id: 456, email: "organizer@example.com" },
          eventType: {
            hosts: [{ userId: 789, user: { email: "host@example.com" } }],
            users: [],
          },
          attendees: [{ email: "host@example.com" }],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(null);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
      });
    });

    describe("Case 3: Team Event Access", () => {
      it("should return true when user has booking.readTeamBookings permission", async () => {
        const mockBooking = {
          userId: 456,
          eventType: {
            teamId: 100,
          },
          attendees: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockPermissionCheckService.checkPermission.mockResolvedValue(true);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenCalledWith({
          userId: 123,
          teamId: 100,
          permission: "booking.readTeamBookings",
          fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
        });
      });

      it("should return false when user lacks booking.readTeamBookings permission", async () => {
        const mockBooking = {
          userId: 456,
          eventType: {
            teamId: 100,
          },
          attendees: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockPermissionCheckService.checkPermission.mockResolvedValue(false);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenCalledWith({
          userId: 123,
          teamId: 100,
          permission: "booking.readTeamBookings",
          fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
        });
      });
    });

    describe("Case 4: Org Admin Access (Personal Bookings)", () => {
      beforeEach(() => {
        vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      });

      it("should return true when user has booking.readOrgBookings permission", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        const mockBookingOwner = {
          organizationId: 200,
          teams: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(mockBookingOwner);
        mockPermissionCheckService.checkPermission.mockResolvedValue(true);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenCalledWith({
          userId: 123,
          teamId: 200,
          permission: "booking.readOrgBookings",
          fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
        });
      });

      it("should return false when user lacks booking.readOrgBookings permission", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        const mockBookingOwner = {
          organizationId: 200,
          teams: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(mockBookingOwner);
        mockPermissionCheckService.checkPermission.mockResolvedValue(false);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
      });
    });

    describe("Case 4 with organizations disabled", () => {
      beforeEach(() => {
        vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      });

      it("should not grant access through the booking owner's BlueBee organization", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        const mockBookingOwner = {
          organizationId: 200,
          teams: [],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(mockBookingOwner);
        mockPermissionCheckService.checkPermission.mockResolvedValue(true);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
        expect(mockPermissionCheckService.checkPermission).not.toHaveBeenCalled();
      });
    });

    describe("Case 5: Team Admin Access (Personal Bookings)", () => {
      it("should return true when user has booking.readTeamBookings on ANY team", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        const mockBookingOwner = {
          organizationId: null,
          teams: [{ teamId: 300 }, { teamId: 400 }],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(mockBookingOwner);
        mockPermissionCheckService.checkPermission
          .mockResolvedValueOnce(false) // Team 300 - no permission
          .mockResolvedValueOnce(true); // Team 400 - has permission

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(true);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenCalledTimes(2);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenNthCalledWith(1, {
          userId: 123,
          teamId: 300,
          permission: "booking.readTeamBookings",
          fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
        });
        expect(mockPermissionCheckService.checkPermission).toHaveBeenNthCalledWith(2, {
          userId: 123,
          teamId: 400,
          permission: "booking.readTeamBookings",
          fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
        });
      });

      it("should return false when user lacks permission on all teams", async () => {
        const mockBooking = {
          userId: 456,
          eventType: null,
          attendees: [],
        };

        const mockBookingOwner = {
          organizationId: null,
          teams: [{ teamId: 300 }, { teamId: 400 }],
        };

        mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(mockBooking);
        mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue(mockBookingOwner);
        mockPermissionCheckService.checkPermission.mockResolvedValue(false);

        const result = await service.doesUserIdHaveAccessToBooking({
          userId: 123,
          bookingUid: "test-booking-uid",
        });

        expect(result).toBe(false);
        expect(mockPermissionCheckService.checkPermission).toHaveBeenCalledTimes(2);
      });
    });
  });
  describe("real team role checks (no PBAC stub)", () => {
    let findTeamIdsByAcceptedRole: ReturnType<typeof vi.fn>;
    let realService: BookingAccessService;

    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findTeamIdsByAcceptedRole = vi.fn().mockResolvedValue([]);
      vi.mocked(MembershipRepository).mockImplementation(function () {
        return { findTeamIdsByAcceptedRole } as unknown as MembershipRepository;
      });
      realService = new BookingAccessService(mockPrismaClient);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const teamBooking = { userId: 456, eventType: { teamId: 100 }, attendees: [] };
    const managedBooking = {
      userId: 456,
      eventType: { teamId: null, parent: { teamId: 500 } },
      attendees: [],
    };
    const personalBooking = { userId: 456, eventType: null, attendees: [] };
    const adminRoles = [MembershipRole.OWNER, MembershipRole.ADMIN];
    const parentRoles = [MembershipRole.ADMIN, MembershipRole.OWNER];

    it("denies a team booking to a user without an accepted admin/owner role", async () => {
      mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(teamBooking);

      const result = await realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" });

      expect(result).toBe(false);
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith({
        userId: 123,
        teamId: 100,
        teamRoles: adminRoles,
        parentRoles,
      });
    });

    it("allows a team booking to an accepted team admin or parent org admin", async () => {
      mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(teamBooking);
      findTeamIdsByAcceptedRole.mockResolvedValue([100]);

      await expect(
        realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" })
      ).resolves.toBe(true);
    });

    it("checks the parent team of a managed event type with accepted roles", async () => {
      mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(managedBooking);

      await expect(
        realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" })
      ).resolves.toBe(false);
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith({
        userId: 123,
        teamId: 500,
        teamRoles: adminRoles,
        parentRoles,
      });

      findTeamIdsByAcceptedRole.mockResolvedValue([500]);
      await expect(
        realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" })
      ).resolves.toBe(true);
    });

    it("denies a personal booking unless the user administers the owner's org or one of their teams", async () => {
      mockBookingRepo.findByUidIncludeEventType.mockResolvedValue(personalBooking);
      mockUserRepo.getUserOrganizationAndTeams.mockResolvedValue({
        organizationId: 200,
        teams: [{ teamId: 300 }],
      });

      await expect(
        realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" })
      ).resolves.toBe(false);
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(expect.objectContaining({ teamId: 200 }));
      expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(expect.objectContaining({ teamId: 300 }));

      findTeamIdsByAcceptedRole.mockImplementation(async ({ teamId }: { teamId: number }) =>
        teamId === 300 ? [300] : []
      );
      await expect(
        realService.doesUserIdHaveAccessToBooking({ userId: 123, bookingUid: "uid" })
      ).resolves.toBe(true);
    });
  });
});
