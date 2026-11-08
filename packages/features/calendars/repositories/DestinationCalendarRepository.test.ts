import type { PrismaClient } from "@calcom/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DestinationCalendarRepository } from "./DestinationCalendarRepository";

describe("DestinationCalendarRepository.findDefaultByUserId", () => {
  const findFirst = vi.fn();
  const prismaClient = { destinationCalendar: { findFirst } } as unknown as PrismaClient;

  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
  });

  it("selects the caller's calendar that is not attached to any event type", async () => {
    await new DestinationCalendarRepository(prismaClient).findDefaultByUserId({ userId: 7 });

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 7, eventTypeId: null },
      select: {
        id: true,
        integration: true,
        externalId: true,
        primaryEmail: true,
        userId: true,
        eventTypeId: true,
        credentialId: true,
        createdAt: true,
        updatedAt: true,
        delegationCredentialId: true,
        customCalendarReminder: true,
      },
    });
  });

  it("returns null when the caller has no default calendar", async () => {
    await expect(
      new DestinationCalendarRepository(prismaClient).findDefaultByUserId({ userId: 7 })
    ).resolves.toBeNull();
  });
});
