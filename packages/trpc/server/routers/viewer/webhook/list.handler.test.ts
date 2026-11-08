import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindAcceptedAdminOrOwner = vi.fn();
const mockFindEventType = vi.fn();
const mockListWebhooks = vi.fn();

vi.mock("@calcom/features/users/di/MembershipRepository.container", () => ({
  getMembershipRepository: () => ({
    findAcceptedAdminOrOwnerByUserIdAndTeamId: (...args: unknown[]) => mockFindAcceptedAdminOrOwner(...args),
  }),
}));
vi.mock("@calcom/features/eventtypes/di/EventTypeRepository.container", () => ({
  getEventTypeRepository: () => ({
    findByIdWithUserIdAndTeamId: (...args: unknown[]) => mockFindEventType(...args),
  }),
}));
vi.mock("@calcom/features/di/webhooks/containers/webhook", () => ({
  getWebhookFeature: () => ({ repository: { listWebhooks: mockListWebhooks } }),
}));

import { listHandler } from "./list.handler";

const user = { id: 7, role: "USER" } as never;
const mockEventType = (eventType: { userId: number | null; teamId: number | null } | null) =>
  mockFindEventType.mockResolvedValue(eventType);

describe("listHandler event type access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListWebhooks.mockResolvedValue([{ id: "wh-1", secret: "s" }]);
    mockFindAcceptedAdminOrOwner.mockResolvedValue(null);
  });

  it("lists without an event type check when no eventTypeId is given", async () => {
    const result = await listHandler({ ctx: { user }, input: { appId: "zapier" } });

    expect(mockFindEventType).not.toHaveBeenCalled();
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

    expect(mockFindEventType).toHaveBeenCalledWith({ id: 11 });
    expect(mockFindAcceptedAdminOrOwner).not.toHaveBeenCalled();
    expect(mockListWebhooks).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, eventTypeId: 11 }));
  });

  it("lists team event type webhooks for an accepted team admin/owner", async () => {
    mockEventType({ userId: null, teamId: 3 });
    mockFindAcceptedAdminOrOwner.mockResolvedValue({ id: 1 });

    await listHandler({ ctx: { user }, input: { eventTypeId: 11 } });

    expect(mockFindAcceptedAdminOrOwner).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
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
    expect(mockFindAcceptedAdminOrOwner).not.toHaveBeenCalled();
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
