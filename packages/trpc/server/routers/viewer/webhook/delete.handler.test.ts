import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindAcceptedAdminOrOwner = vi.fn();
const mockUpdateTriggerForExistingBookings = vi.fn();

vi.mock("@calcom/features/users/di/MembershipRepository.container", () => ({
  getMembershipRepository: () => ({
    findAcceptedAdminOrOwnerByUserIdAndTeamId: (...args: unknown[]) => mockFindAcceptedAdminOrOwner(...args),
  }),
}));
vi.mock("@calcom/features/webhooks/lib/scheduleTrigger", () => ({
  updateTriggerForExistingBookings: (...args: unknown[]) => mockUpdateTriggerForExistingBookings(...args),
}));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    webhook: { findFirst: vi.fn(), delete: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { deleteHandler } from "./delete.handler";

const user = { id: 7, role: "USER" } as never;

const teamOwnedWebhook = {
  id: "wh-team",
  userId: null,
  teamId: 3,
  eventTypeId: null,
  eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
};

const ownedWebhook = { ...teamOwnedWebhook, id: "wh-own", userId: 7 };

describe("deleteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAcceptedAdminOrOwner.mockResolvedValue({ id: 1 });
  });

  it("deletes a user-owned webhook without a team membership check", async () => {
    vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce(ownedWebhook as never);

    await expect(deleteHandler({ ctx: { user }, input: { id: "wh-own" } })).resolves.toEqual({
      id: "wh-own",
    });

    expect(vi.mocked(prisma.webhook.findFirst).mock.calls[0][0]).toEqual({
      where: { AND: [{ id: "wh-own" }, { userId: 7 }] },
    });
    expect(prisma.webhook.delete).toHaveBeenCalledWith({ where: { id: "wh-own" } });
    expect(mockUpdateTriggerForExistingBookings).toHaveBeenCalledWith(
      ownedWebhook,
      ownedWebhook.eventTriggers,
      []
    );
    expect(mockFindAcceptedAdminOrOwner).not.toHaveBeenCalled();
  });

  it("lets a team admin delete a team-owned webhook and clears its scheduled triggers", async () => {
    vi.mocked(prisma.webhook.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(teamOwnedWebhook as never);

    await expect(deleteHandler({ ctx: { user }, input: { id: "wh-team" } })).resolves.toEqual({
      id: "wh-team",
    });

    expect(vi.mocked(prisma.webhook.findFirst).mock.calls[1][0]).toEqual({
      where: { id: "wh-team", userId: null, teamId: { not: null }, eventTypeId: null },
    });
    expect(mockFindAcceptedAdminOrOwner).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(prisma.webhook.delete).toHaveBeenCalledWith({ where: { id: "wh-team" } });
    expect(mockUpdateTriggerForExistingBookings).toHaveBeenCalledWith(
      teamOwnedWebhook,
      teamOwnedWebhook.eventTriggers,
      []
    );
  });

  it("forbids a non-admin member from deleting a team-owned webhook", async () => {
    mockFindAcceptedAdminOrOwner.mockResolvedValue(null);
    vi.mocked(prisma.webhook.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(teamOwnedWebhook as never);

    await expect(deleteHandler({ ctx: { user }, input: { id: "wh-team" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
    expect(mockUpdateTriggerForExistingBookings).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND instead of silently succeeding when nothing matches", async () => {
    vi.mocked(prisma.webhook.findFirst).mockResolvedValue(null);

    await expect(deleteHandler({ ctx: { user }, input: { id: "wh-missing" } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
  });
});
