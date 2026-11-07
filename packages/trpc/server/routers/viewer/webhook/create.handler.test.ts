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
}));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    webhook: { create: vi.fn() },
    team: { findUnique: vi.fn() },
    eventType: { findFirst: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { updateTriggerForExistingBookings } from "@calcom/features/webhooks/lib/scheduleTrigger";
import { prisma } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { createHandler } from "./create.handler";
import type { TCreateInputSchema } from "./create.schema";

const user = { id: 7, role: "USER" } as never;

const baseInput: TCreateInputSchema = {
  subscriberUrl: "https://crm.example.com/hooks/calcom",
  eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
  active: true,
  payloadTemplate: null,
};

const createdData = () => vi.mocked(prisma.webhook.create).mock.calls[0][0].data;

describe("createHandler includeMemberMeetings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.create).mockImplementation(
      (args) => Promise.resolve({ ...args.data, eventTriggers: baseInput.eventTriggers }) as never
    );
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ isOrganization: false } as never);
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
  });

  it("keeps connecting the creator for unflagged team webhooks", async () => {
    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } });

    expect(createdData().user).toEqual({ connect: { id: 7 } });
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
  });

  it("creates a flagged team webhook without a user for a team admin", async () => {
    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3, includeMemberMeetings: true } });

    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(createdData().user).toBeUndefined();
    expect(createdData().includeMemberMeetings).toBe(true);
    expect(updateTriggerForExistingBookings).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 3, includeMemberMeetings: true }),
      [],
      baseInput.eventTriggers
    );
  });

  it("requires a team", async () => {
    await expect(
      createHandler({ ctx: { user }, input: { ...baseInput, includeMemberMeetings: true } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("rejects platform webhooks", async () => {
    await expect(
      createHandler({
        ctx: { user: { id: 7, role: "ADMIN" } as never },
        input: { ...baseInput, teamId: 3, platform: true, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects event type webhooks", async () => {
    await expect(
      createHandler({
        ctx: { user },
        input: { ...baseInput, teamId: 3, eventTypeId: 11, includeMemberMeetings: true },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects organizations", async () => {
    vi.mocked(prisma.team.findUnique).mockResolvedValue({ isOrganization: true } as never);

    await expect(
      createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3, includeMemberMeetings: true } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("forbids non-admin members", async () => {
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(
      createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3, includeMemberMeetings: true } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });
});

describe("createHandler cross-organization team isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.create).mockImplementation(
      (args) => Promise.resolve({ ...args.data, eventTriggers: baseInput.eventTriggers }) as never
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers NOT_FOUND for a team the caller is not a member of when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(false);

    await expect(createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Team not found",
    });
    expect(mockHasMembership).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("creates the webhook for a team member when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(true);

    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } });

    expect(mockHasMembership).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(createdData().teamId).toBe(3);
  });

  it("skips the membership check when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } });

    expect(mockHasMembership).not.toHaveBeenCalled();
    expect(createdData().user).toEqual({ connect: { id: 7 } });
  });
});
