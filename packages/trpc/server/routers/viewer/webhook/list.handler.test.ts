import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAdminOrOwnerMembership = vi.fn();
const mockListWebhooks = vi.fn();

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    static getAdminOrOwnerMembership(...args: unknown[]) {
      return mockGetAdminOrOwnerMembership(...args);
    }
  },
}));
vi.mock("@calcom/features/di/webhooks/containers/webhook", () => ({
  getWebhookFeature: () => ({ repository: { listWebhooks: mockListWebhooks } }),
}));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = { eventType: { findUnique: vi.fn() } };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import { listHandler } from "./list.handler";

const user = { id: 7, role: "USER" } as never;
const mockEventType = (eventType: { userId: number | null; teamId: number | null } | null) =>
  vi.mocked(prisma.eventType.findUnique).mockResolvedValue(eventType as never);

describe("listHandler event type access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListWebhooks.mockResolvedValue([{ id: "wh-1", secret: "s" }]);
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);
  });

  it("lists without an event type check when no eventTypeId is given", async () => {
    const result = await listHandler({ ctx: { user }, input: { appId: "zapier" } });

    expect(prisma.eventType.findUnique).not.toHaveBeenCalled();
    expect(mockListWebhooks).toHaveBeenCalledWith({
      userId: 7,
      appId: "zapier",
      eventTypeId: undefined,
      eventTriggers: undefined,
    });
    expect(result).toEqual([{ id: "wh-1", secret: "s" }]);
  });

  it("lists webhooks of the viewer's own event type", async () => {
    mockEventType({ userId: 7, teamId: null });

    await listHandler({ ctx: { user }, input: { eventTypeId: 11 } });

    expect(prisma.eventType.findUnique).toHaveBeenCalledWith({
      where: { id: 11 },
      select: { userId: true, teamId: true },
    });
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(mockListWebhooks).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, eventTypeId: 11 }));
  });

  it("lists team event type webhooks for an accepted team admin/owner", async () => {
    mockEventType({ userId: null, teamId: 3 });
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });

    await listHandler({ ctx: { user }, input: { eventTypeId: 11 } });

    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(mockListWebhooks).toHaveBeenCalledTimes(1);
  });

  it("rejects a team member who is not an accepted admin/owner", async () => {
    mockEventType({ userId: null, teamId: 3 });

    await expect(listHandler({ ctx: { user }, input: { eventTypeId: 11 } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mockListWebhooks).not.toHaveBeenCalled();
  });

  it("rejects another user's personal event type", async () => {
    mockEventType({ userId: 99, teamId: null });

    await expect(listHandler({ ctx: { user }, input: { eventTypeId: 11 } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(mockListWebhooks).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown event type", async () => {
    mockEventType(null);

    await expect(listHandler({ ctx: { user }, input: { eventTypeId: 11 } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mockListWebhooks).not.toHaveBeenCalled();
  });
});
