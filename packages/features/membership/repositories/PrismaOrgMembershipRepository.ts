import { topLevelTeamFilter } from "@calcom/lib/organizations/topLevelTeamFilter";
import { prisma } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";

export class PrismaOrgMembershipRepository {
  static async getOrgIdsWhereAdmin(loggedInUserId: number) {
    const loggedInUserOrgMemberships = await prisma.membership.findMany({
      where: {
        userId: loggedInUserId,
        role: {
          in: [MembershipRole.OWNER, MembershipRole.ADMIN],
        },
        team: topLevelTeamFilter(),
      },
      select: {
        teamId: true,
      },
    });

    return loggedInUserOrgMemberships.map((m) => m.teamId);
  }

  static async isLoggedInUserOrgAdminOfBookingHost(loggedInUserId: number, bookingUserId: number) {
    const orgIdsWhereLoggedInUserAdmin =
      await PrismaOrgMembershipRepository.getOrgIdsWhereAdmin(loggedInUserId);

    if (orgIdsWhereLoggedInUserAdmin.length === 0) {
      return false;
    }

    const bookingUserOrgMembership = await prisma.membership.findFirst({
      where: {
        userId: bookingUserId,
        teamId: {
          in: orgIdsWhereLoggedInUserAdmin,
        },
        team: topLevelTeamFilter(),
      },
      select: {
        userId: true,
      },
    });

    if (bookingUserOrgMembership) return true;

    const bookingUserOrgTeamMembership = await prisma.membership.findFirst({
      where: {
        userId: bookingUserId,
        team: {
          parentId: {
            in: orgIdsWhereLoggedInUserAdmin,
          },
        },
      },
    });

    return !!bookingUserOrgTeamMembership;
  }
}
