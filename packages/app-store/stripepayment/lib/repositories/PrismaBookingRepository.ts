import type { PrismaClient } from "@calcom/prisma";
import { bookingMinimalSelect } from "@calcom/prisma/selects/booking";

export class PrismaBookingRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByIdIncludeUserAndAttendees(bookingId: number) {
    return await this.prismaClient.booking.findUnique({
      where: {
        id: bookingId,
      },
      select: {
        ...bookingMinimalSelect,
        eventType: {
          select: {
            title: true,
          },
        },
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        attendees: {
          select: {
            name: true,
            email: true,
            phoneNumber: true,
          },
          // Ascending order ensures that the first attendee in the list is the booker and others are guests
          // See why it is important https://github.com/calcom/cal.diy/pull/20935
          // TODO: Ideally we should return `booker` property directly from the booking
          orderBy: {
            id: "asc",
          },
        },
      },
    });
  }
}
