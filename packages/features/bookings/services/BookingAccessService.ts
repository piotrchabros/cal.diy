import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { TeamRolePermissionService } from "@calcom/features/membership/services/TeamRolePermissionService";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { BookingRepository } from "../repositories/BookingRepository";

type BookingForAccessCheck = NonNullable<Awaited<ReturnType<BookingRepository["findByUidIncludeEventType"]>>>;

export class BookingAccessService {
  private permissionCheckService: TeamRolePermissionService;

  constructor(private prismaClient: PrismaClient) {
    this.permissionCheckService = new TeamRolePermissionService(new MembershipRepository(prismaClient));
  }

  private isUserAHost(userId: number, booking: BookingForAccessCheck): boolean {
    const hostMap = new Map<number, { id: number; email: string }>();

    const addHost = (id: number, email: string) => {
      if (!hostMap.has(id)) {
        hostMap.set(id, { id, email });
      }
    };

    booking?.eventType?.hosts?.forEach((host: { userId: number; user: { email: string } }) =>
      addHost(host.userId, host.user.email)
    );
    booking?.eventType?.users?.forEach((user: { id: number; email: string }) => addHost(user.id, user.email));

    if (booking?.user?.id && booking?.user?.email) {
      addHost(booking.user.id, booking.user.email);
    }

    const attendeeEmails = new Set(booking.attendees?.map((attendee: { email: string }) => attendee.email));
    const filteredHosts = Array.from(hostMap.values()).filter(
      (host) => attendeeEmails.has(host.email) || host.id === booking.user?.id
    );

    return filteredHosts.some((host) => host.id === userId);
  }

  /**
   * Determines if a user has access to a booking based on:
   * 1. Being the booking organizer
   * 2. Being one of the hosts in a multi-host booking
   * 3. Being an accepted team admin/owner (or parent org admin/owner) where the event type belongs
   * 4. Being an accepted org admin/owner where the booking organizer belongs (for personal bookings)
   * 5. Being an accepted team admin/owner of any team the booking organizer belongs to (for personal bookings)
   */
  async doesUserIdHaveAccessToBooking({
    userId,
    bookingUid,
    bookingId,
  }: {
    userId: number;
    bookingUid?: string;
    bookingId?: number;
  }): Promise<boolean> {
    const bookingRepo = new BookingRepository(this.prismaClient);
    const userRepo = new UserRepository(this.prismaClient);

    // Fetch booking by UID or ID
    const booking = bookingUid
      ? await bookingRepo.findByUidIncludeEventType({ bookingUid })
      : bookingId
        ? await bookingRepo.findByIdIncludeEventType({ bookingId })
        : null;

    if (!booking) return false;

    // Case 1: User is the booking organizer
    if (userId === booking.userId) return true;

    // Case 2: User is one of the hosts
    if (this.isUserAHost(userId, booking)) return true;

    // Case 3: If booking has a teamId, check if user has access to team bookings
    if (booking.eventType?.teamId) {
      const teamId = booking.eventType.teamId;

      const hasAccess = await this.permissionCheckService.checkPermission({
        userId,
        teamId,
        permission: "booking.readTeamBookings",
        fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
      });
      return hasAccess;
    }

    // For managed events (child event types), check the parent's teamId
    if (booking.eventType?.parent?.teamId) {
      return this.permissionCheckService.checkPermission({
        userId,
        teamId: booking.eventType.parent.teamId,
        permission: "booking.readTeamBookings",
        fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
      });
    }

    if (!booking.userId) return false;

    const bookingOwner = await userRepo.getUserOrganizationAndTeams({ userId: booking.userId });

    if (!bookingOwner) return false;

    // Case 4: Check if user is admin of booking organizer's organization.
    // While organizations are off every user still belongs to BlueBee, so its admins must not see personal bookings.
    if (isOrganizationsEnabled() && bookingOwner.organizationId) {
      const orgId = bookingOwner.organizationId;

      const hasAccess = await this.permissionCheckService.checkPermission({
        userId,
        teamId: orgId,
        permission: "booking.readOrgBookings",
        fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
      });
      if (hasAccess) return true;
    }

    // Case 5: Check if user is admin of any team the booking organizer belongs to
    for (const membership of bookingOwner.teams) {
      const teamId = membership.teamId;

      const hasAccess = await this.permissionCheckService.checkPermission({
        userId,
        teamId,
        permission: "booking.readTeamBookings",
        fallbackRoles: [MembershipRole.OWNER, MembershipRole.ADMIN],
      });
      if (hasAccess) return true;
    }

    return false;
  }
}
