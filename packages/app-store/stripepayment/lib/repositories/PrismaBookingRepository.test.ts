import type { PrismaClient } from "@calcom/prisma";
import { bookingMinimalSelect } from "@calcom/prisma/selects/booking";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaBookingRepository } from "./PrismaBookingRepository";

describe("PrismaBookingRepository", () => {
  const findUnique = vi.fn();
  const prismaFake = { booking: { findUnique } };
  let repository: PrismaBookingRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new PrismaBookingRepository(prismaFake as unknown as PrismaClient);
  });

  describe("findByIdIncludeUserAndAttendees", () => {
    test("queries the booking by id with user, event type and ordered attendees", async () => {
      const booking = {
        id: 5,
        title: "Paid meeting",
        eventType: { title: "30 min" },
        user: { id: 1, username: "owner" },
        attendees: [{ name: "Booker", email: "booker@example.com", phoneNumber: null }],
      };
      findUnique.mockResolvedValue(booking);

      const result = await repository.findByIdIncludeUserAndAttendees(5);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 5 },
        select: {
          ...bookingMinimalSelect,
          eventType: { select: { title: true } },
          user: { select: { id: true, username: true } },
          attendees: {
            select: { name: true, email: true, phoneNumber: true },
            orderBy: { id: "asc" },
          },
        },
      });
      expect(result).toBe(booking);
    });

    test("returns null when the booking does not exist", async () => {
      findUnique.mockResolvedValue(null);

      const result = await repository.findByIdIncludeUserAndAttendees(5);

      expect(result).toBeNull();
    });
  });
});
