import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { SchedulingType } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSyncEventType } = vi.hoisted(() => ({ mockSyncEventType: vi.fn() }));

vi.mock("@calcom/features/host/di/AssignAllTeamMembersHostService.container", () => ({
  getAssignAllTeamMembersHostService: () => ({ syncEventType: mockSyncEventType }),
}));

vi.mock("@calcom/features/hashedLink/lib/repository/HashedLinkRepository", () => ({
  HashedLinkRepository: { create: () => ({ findLinksByEventTypeId: async () => [] }) },
}));

vi.mock("@calcom/features/hashedLink/lib/service/HashedLinkService", () => ({
  HashedLinkService: class {
    handleMultiplePrivateLinks = vi.fn();
  },
}));

vi.mock("@calcom/features/tasker", () => ({ default: { create: vi.fn() } }));

import { updateHandler } from "./update.handler";

describe("update.handler", () => {
  describe("bookingFields null to Prisma.DbNull transformation", () => {
    function transformBookingFields(
      bookingFields: null | undefined | Prisma.InputJsonValue
    ): typeof Prisma.DbNull | Prisma.InputJsonValue | undefined {
      return bookingFields === null ? Prisma.DbNull : (bookingFields as Prisma.InputJsonValue | undefined);
    }

    it("should convert null to Prisma.DbNull", () => {
      const result = transformBookingFields(null);
      expect(result).toBe(Prisma.DbNull);
    });

    it("should pass through undefined as-is", () => {
      const result = transformBookingFields(undefined);
      expect(result).toBeUndefined();
    });

    it("should pass through an array of booking fields as-is", () => {
      const bookingFieldsArray = [
        {
          name: "email",
          type: "email",
          label: "Email",
          required: true,
          hidden: false,
        },
        {
          name: "name",
          type: "name",
          label: "Name",
          required: true,
          hidden: false,
        },
      ];

      const result = transformBookingFields(bookingFieldsArray);
      expect(result).toEqual(bookingFieldsArray);
    });

    it("should pass through an empty array as-is", () => {
      const result = transformBookingFields([]);
      expect(result).toEqual([]);
    });

    it("should distinguish between null and empty array", () => {
      const nullResult = transformBookingFields(null);
      const emptyArrayResult = transformBookingFields([]);

      expect(nullResult).toBe(Prisma.DbNull);
      expect(emptyArrayResult).toEqual([]);
      expect(nullResult).not.toEqual(emptyArrayResult);
    });
  });

  describe("assign all team members host sync", () => {
    const user = {
      id: 1,
      username: "owner",
      profile: { id: null },
      userLevelSelectedCalendars: [],
      organizationId: null,
      email: "owner@example.com",
      locale: "en",
    };

    function createPrisma(updated: { assignAllTeamMembers: boolean; teamId: number | null }) {
      return {
        eventType: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            title: "Team event",
            locations: [],
            description: null,
            seatsPerTimeSlot: null,
            recurringEvent: null,
            maxActiveBookingsPerBooker: null,
            fieldTranslations: [],
            isRRWeightsEnabled: false,
            hosts: [],
            calVideoSettings: null,
            children: [],
            hostGroups: [],
            team: null,
          }),
          update: vi.fn().mockResolvedValue({
            slug: "team-event",
            schedulingType: SchedulingType.ROUND_ROBIN,
            ...updated,
          }),
        },
      } as unknown as PrismaClient;
    }

    beforeEach(() => {
      mockSyncEventType.mockReset();
    });

    it("syncs hosts when the saved event type assigns all team members", async () => {
      const prisma = createPrisma({ assignAllTeamMembers: true, teamId: 10 });

      await updateHandler({ ctx: { user, prisma }, input: { id: 100 } });

      expect(mockSyncEventType).toHaveBeenCalledWith({
        eventTypeId: 100,
        teamId: 10,
        schedulingType: SchedulingType.ROUND_ROBIN,
      });
    });

    it("does not sync hosts when assign all team members is off", async () => {
      const prisma = createPrisma({ assignAllTeamMembers: false, teamId: 10 });

      await updateHandler({ ctx: { user, prisma }, input: { id: 100 } });

      expect(mockSyncEventType).not.toHaveBeenCalled();
    });

    it("does not sync hosts for a non-team event type", async () => {
      const prisma = createPrisma({ assignAllTeamMembers: true, teamId: null });

      await updateHandler({ ctx: { user, prisma }, input: { id: 100 } });

      expect(mockSyncEventType).not.toHaveBeenCalled();
    });
  });
});
