import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAdminOrOwnerMembership = vi.fn();
const mockHasMembership = vi.fn();

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    static getAdminOrOwnerMembership(...args: unknown[]) {
      return mockGetAdminOrOwnerMembership(...args);
    }
    hasMembership(...args: unknown[]) {
      return mockHasMembership(...args);
    }
  },
}));
vi.mock("@calcom/features/webhooks/lib/scheduleTrigger", () => ({
  updateTriggerForExistingBookings: vi.fn(),
  deleteWebhookScheduledTriggers: vi.fn(),
  cancelNoShowTasksForBooking: vi.fn(),
}));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    webhook: { findUnique: vi.fn(), update: vi.fn() },
    team: { findUnique: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { updateTriggerForExistingBookings } from "@calcom/features/webhooks/lib/scheduleTrigger";
import { prisma } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { editHandler } from "./edit.handler";

const user = { id: 7, role: "USER" } as never;

const existingWebhook = {
  id: "wh-1",
  subscriberUrl: "https://crm.example.com/hooks/calcom",
  active: true,
  eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
  teamId: 3,
  userId: 7,
  eventTypeId: null,
  platform: false,
  includeMemberMeetings: false,
};

const updatedData = () => vi.mocked(prisma.webhook.update).mock.calls[0][0].data;

describe("editHandler includeMemberMeetings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(existingWebhook as never);
    vi.mocked(prisma.webhook.update).mockImplementation(
      (args) => Promise.resolve({ ...existingWebhook, ...args.data }) as never
    );
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ isOrganization: false } as never);
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
  });

  it("leaves unflagged webhook edits unchanged", async () => {
    await editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, active: false } });

    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(updatedData()).not.toHaveProperty("userId");
  });

  it("reconciles existing bookings with the updated webhook and the previous flag", async () => {
    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, active: true, includeMemberMeetings: true },
    });

    expect(updateTriggerForExistingBookings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wh-1", includeMemberMeetings: true, userId: null }),
      existingWebhook.eventTriggers,
      existingWebhook.eventTriggers,
      false
    );
  });

  it("passes the previous flag when an admin turns it off", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      ...existingWebhook,
      userId: null,
      includeMemberMeetings: true,
    } as never);

    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, active: true, includeMemberMeetings: false },
    });

    expect(updateTriggerForExistingBookings).toHaveBeenCalledWith(
      expect.objectContaining({ includeMemberMeetings: false }),
      existingWebhook.eventTriggers,
      existingWebhook.eventTriggers,
      true
    );
  });

  it("does not pass the previous flag when re-activating an inactive webhook", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ ...existingWebhook, active: false } as never);

    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, active: true, includeMemberMeetings: true },
    });

    expect(updateTriggerForExistingBookings).toHaveBeenCalledWith(
      expect.objectContaining({ includeMemberMeetings: true }),
      [],
      existingWebhook.eventTriggers,
      undefined
    );
  });

  it("detaches the user when a team admin enables the flag", async () => {
    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: true },
    });

    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(updatedData()).toMatchObject({ includeMemberMeetings: true, userId: null });
  });

  it("forbids a non-admin member from enabling the flag", async () => {
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(
      editHandler({
        ctx: { user },
        input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("forbids a non-admin member from editing any field of a flagged webhook", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      ...existingWebhook,
      userId: null,
      includeMemberMeetings: true,
    } as never);
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, active: false } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("keeps userId null when an admin turns the flag off", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      ...existingWebhook,
      userId: null,
      includeMemberMeetings: true,
    } as never);

    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: false },
    });

    expect(updatedData()).toMatchObject({ includeMemberMeetings: false });
    expect(updatedData()).not.toHaveProperty("userId");
  });

  it("rejects enabling the flag on a personal webhook", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ ...existingWebhook, teamId: null } as never);

    await expect(
      editHandler({
        ctx: { user },
        input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects enabling the flag on an event type webhook", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ ...existingWebhook, eventTypeId: 11 } as never);

    await expect(
      editHandler({
        ctx: { user },
        input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects enabling the flag for an organization", async () => {
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ isOrganization: true } as never);

    await expect(
      editHandler({
        ctx: { user },
        input: { id: "wh-1", payloadTemplate: null, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("editHandler team-owned webhook scope", () => {
  const teamOwnedWebhook = { ...existingWebhook, userId: null, includeMemberMeetings: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(teamOwnedWebhook as never);
    vi.mocked(prisma.webhook.update).mockImplementation(
      (args) => Promise.resolve({ ...teamOwnedWebhook, ...args.data }) as never
    );
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ isOrganization: false } as never);
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
    mockHasMembership.mockResolvedValue(true);
  });

  it("rejects moving a team-owned webhook to another team, even for an admin of both", async () => {
    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 4 } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("rejects turning a team-owned webhook into an event type webhook", async () => {
    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, eventTypeId: 11 } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("rejects moving a team-owned webhook even after the flag is turned off", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      ...teamOwnedWebhook,
      includeMemberMeetings: false,
    } as never);

    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 4 } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("rejects changing the team while enabling the flag", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(existingWebhook as never);

    await expect(
      editHandler({
        ctx: { user },
        input: { id: "wh-1", payloadTemplate: null, teamId: 4, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("allows an edit that resends the unchanged teamId", async () => {
    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, teamId: 3, active: false },
    });

    expect(updatedData()).toMatchObject({ teamId: 3, active: false });
  });

  it("still allows moving a user-owned webhook between teams", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(existingWebhook as never);

    await editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 4 } });

    expect(updatedData()).toMatchObject({ teamId: 4 });
    expect(updatedData()).not.toHaveProperty("userId");
  });
});

describe("editHandler moving a personal webhook onto a team", () => {
  const personalWebhook = { ...existingWebhook, teamId: null };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(personalWebhook as never);
    vi.mocked(prisma.webhook.update).mockImplementation(
      (args) => Promise.resolve({ ...personalWebhook, ...args.data }) as never
    );
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
    mockHasMembership.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forbids moving it to a team the caller does not administer when organizations are off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 9 } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockHasMembership).not.toHaveBeenCalled();
    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 9);
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("hides another organization's team when organizations are on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(false);

    await expect(
      editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 9 } })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Team not found" });
    expect(mockHasMembership).toHaveBeenCalledWith({ userId: 7, teamId: 9 });
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(prisma.webhook.update).not.toHaveBeenCalled();
  });

  it("allows a team admin to move it onto their team", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await editHandler({ ctx: { user }, input: { id: "wh-1", payloadTemplate: null, teamId: 9 } });

    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 9);
    expect(updatedData()).toMatchObject({ teamId: 9 });
  });

  it("skips the team checks when the teamId is unchanged", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(existingWebhook as never);

    await editHandler({
      ctx: { user },
      input: { id: "wh-1", payloadTemplate: null, teamId: 3, active: false },
    });

    expect(mockHasMembership).not.toHaveBeenCalled();
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(updatedData()).toMatchObject({ teamId: 3, active: false });
  });
});
