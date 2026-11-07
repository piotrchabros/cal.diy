import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckUsername, mockUserUpdate, mockDisableByFrom, mockRepoint } = vi.hoisted(() => ({
  mockRepoint: vi.fn(),
  mockCheckUsername: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockDisableByFrom: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/TempOrgRedirectRepository.container", () => ({
  getTempOrgRedirectRepository: () => ({ disableByFrom: mockDisableByFrom }),
}));

vi.mock("@calcom/features/organizations/lib/repointUserRedirectsForRename", () => ({
  repointUserRedirectsForRename: mockRepoint,
}));

vi.mock("@calcom/features/profile/lib/checkUsername", () => ({
  checkUsername: mockCheckUsername,
}));

vi.mock("@calcom/prisma", () => ({
  prisma: {
    user: { update: mockUserUpdate, findUnique: vi.fn() },
    secondaryEmail: { findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
    travelSchedule: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    schedule: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@calcom/features/flags/features.repository", () => ({
  FeaturesRepository: class {
    checkIfFeatureIsEnabledGlobally = vi.fn().mockResolvedValue(false);
  },
}));

vi.mock("@calcom/features/schedules/repositories/ScheduleRepository", () => ({
  ScheduleRepository: class {
    getDefaultScheduleId = vi.fn();
  },
}));

vi.mock("@calcom/features/auth/lib/verifyEmail", () => ({
  sendChangeOfEmailVerification: vi.fn(),
}));

vi.mock("@calcom/app-store/stripepayment/lib/utils", () => ({
  getPremiumMonthlyPlanPriceId: vi.fn(),
}));

vi.mock("@calcom/lib/server/avatar", () => ({ uploadAvatar: vi.fn() }));
vi.mock("@calcom/lib/server/resizeBase64Image", () => ({ resizeBase64Image: vi.fn() }));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn().mockResolvedValue((key: string) => key),
}));

import { updateProfileHandler } from "./updateProfile.handler";

type HandlerOptions = Parameters<typeof updateProfileHandler>[0];

const makeCtx = (overrides: Partial<HandlerOptions["ctx"]["user"]> = {}): HandlerOptions["ctx"] =>
  ({
    user: {
      id: 1,
      username: "current",
      email: "user@example.com",
      locale: "en",
      metadata: {},
      timeZone: "UTC",
      emailVerified: null,
      defaultScheduleId: null,
      organizationId: null,
      movedToProfileId: null,
      ...overrides,
    },
  }) as HandlerOptions["ctx"];

const getUpdateData = () => mockUserUpdate.mock.calls[0][0].data;

describe("updateProfileHandler username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckUsername.mockResolvedValue({ available: true, premium: false });
    mockUserUpdate.mockResolvedValue({
      id: 1,
      username: "new-name",
      email: "user@example.com",
      metadata: {},
      avatarUrl: null,
      schedules: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not check the username of an org user when ORGANIZATIONS_ENABLED is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "new-name" } });

    expect(mockCheckUsername).not.toHaveBeenCalled();
  });

  it("checks the username within the caller's organization when ORGANIZATIONS_ENABLED is on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "New Name" } });

    expect(mockCheckUsername).toHaveBeenCalledWith("new-name", { organizationId: 10 });
    expect(getUpdateData().username).toBe("new-name");
  });

  it("throws BAD_REQUEST when the username is taken in the organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    mockCheckUsername.mockResolvedValue({ available: false, premium: false });

    const promise = updateProfileHandler({
      ctx: makeCtx({ organizationId: 10 }),
      input: { username: "taken" },
    });

    await expect(promise).rejects.toBeInstanceOf(TRPCError);
    await expect(promise).rejects.toMatchObject({ code: "BAD_REQUEST", message: "username_already_taken" });
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "true",
  ])("checks a user without an organization in the global namespace (ORGANIZATIONS_ENABLED=%j)", async (flag) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", flag);

    await updateProfileHandler({ ctx: makeCtx(), input: { username: "new-name" } });

    expect(mockCheckUsername).toHaveBeenCalledWith("new-name", null);
  });

  it.each([
    "",
    "true",
  ])("leaves user.username untouched for a user moved to an org profile (ORGANIZATIONS_ENABLED=%j)", async (flag) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", flag);

    await updateProfileHandler({
      ctx: makeCtx({ organizationId: 10, movedToProfileId: 5 }),
      input: { username: "new-name" },
    });

    expect(mockCheckUsername).not.toHaveBeenCalled();
    expect(getUpdateData()).not.toHaveProperty("username");
  });

  it("skips the check when the username is unchanged", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "current" } });

    expect(mockCheckUsername).not.toHaveBeenCalled();
  });
});

describe("updateProfileHandler reused username redirects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckUsername.mockResolvedValue({ available: true, premium: false });
    mockDisableByFrom.mockResolvedValue(1);
    mockUserUpdate.mockResolvedValue({
      id: 1,
      username: "new-name",
      email: "user@example.com",
      metadata: {},
      avatarUrl: null,
      schedules: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables User redirects from the new username in the caller's organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "new-name" } });

    expect(mockDisableByFrom).toHaveBeenCalledWith({ fromOrgId: 10, from: "new-name", types: ["User"] });
  });

  it("repoints move redirects in the caller's organization from the old to the new username", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "new-name" } });

    expect(mockRepoint).toHaveBeenCalledWith({
      organizationId: 10,
      oldUsername: "current",
      newUsername: "new-name",
    });
  });

  it("does not disable redirects when ORGANIZATIONS_ENABLED is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "new-name" } });

    expect(mockDisableByFrom).not.toHaveBeenCalled();
  });

  it("does not disable redirects when the username is unchanged", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    mockUserUpdate.mockResolvedValue({
      id: 1,
      username: "current",
      email: "user@example.com",
      metadata: {},
      avatarUrl: null,
      schedules: [],
    });

    await updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "current" } });

    expect(mockDisableByFrom).not.toHaveBeenCalled();
  });

  it("does not disable redirects when the user update fails", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    mockUserUpdate.mockRejectedValue(new Error("db down"));

    await expect(
      updateProfileHandler({ ctx: makeCtx({ organizationId: 10 }), input: { username: "new-name" } })
    ).rejects.toThrow("db down");

    expect(mockRepoint).not.toHaveBeenCalled();
    expect(mockDisableByFrom).not.toHaveBeenCalled();
  });

  it("does not disable redirects for a user without an organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    await updateProfileHandler({ ctx: makeCtx(), input: { username: "new-name" } });

    expect(mockDisableByFrom).not.toHaveBeenCalled();
  });
});
