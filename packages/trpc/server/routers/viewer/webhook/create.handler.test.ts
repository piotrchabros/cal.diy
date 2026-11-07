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

  it("creates a flagged team webhook without a user for a team admin", async () => {
    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3, includeMemberMeetings: true } });

    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledTimes(1);
    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(createdData().user).toBeUndefined();
    expect(createdData().userId).toBeUndefined();
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

describe("createHandler team webhook authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.webhook.create).mockImplementation(
      (args) => Promise.resolve({ ...args.data, eventTriggers: baseInput.eventTriggers }) as never
    );
    mockGetAdminOrOwnerMembership.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a team-owned webhook for a team admin when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } });

    expect(mockHasMembership).not.toHaveBeenCalled();
    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(createdData().userId).toBeUndefined();
    expect(createdData().user).toBeUndefined();
    expect(createdData().teamId).toBe(3);
  });

  it("forbids a non-admin team member when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a team the caller is not a member of when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(false);

    await expect(createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Team not found",
    });
    expect(mockHasMembership).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("forbids a team member who is not an admin when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(true);
    mockGetAdminOrOwnerMembership.mockResolvedValue(null);

    await expect(createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("creates the webhook for a team admin when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockHasMembership.mockResolvedValue(true);

    await createHandler({ ctx: { user }, input: { ...baseInput, teamId: 3 } });

    expect(mockHasMembership).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(mockGetAdminOrOwnerMembership).toHaveBeenCalledWith(7, 3);
    expect(createdData().teamId).toBe(3);
    expect(createdData().userId).toBeUndefined();
  });

  it("owns a personal webhook by the creator without an admin lookup", async () => {
    await createHandler({ ctx: { user }, input: baseInput });

    expect(createdData().userId).toBe(7);
    expect(createdData().user).toBeUndefined();
    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
  });

  it("does not set a user on event type webhooks", async () => {
    vi.mocked(prisma.eventType.findFirst).mockResolvedValue(null);

    await createHandler({ ctx: { user }, input: { ...baseInput, eventTypeId: 11 } });

    expect(createdData().userId).toBeUndefined();
    expect(createdData().eventTypeId).toBe(11);
  });

  it("skips the team admin lookup for platform webhooks from a system admin", async () => {
    await createHandler({
      ctx: { user: { id: 7, role: "ADMIN" } as never },
      input: { ...baseInput, teamId: 3, platform: true },
    });

    expect(mockGetAdminOrOwnerMembership).not.toHaveBeenCalled();
    expect(createdData().userId).toBeUndefined();
  });

  it("stores app webhooks with unchecked scalars", async () => {
    await createHandler({ ctx: { user }, input: { ...baseInput, appId: "zapier" } });

    expect(createdData()).toMatchObject({ appId: "zapier", userId: 7 });
    expect(createdData()).not.toHaveProperty("user");
  });
});
