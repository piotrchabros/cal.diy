import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../createContext";
import { createCallerFactory } from "../../../trpc";
import { userAdminRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  disableByFrom: vi.fn(),
  findUnique: vi.fn(),
  $transaction: vi.fn(),
  txUserUpdate: vi.fn(),
  txProfileUpdate: vi.fn(),
  txProfileUpdateMany: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: mocks.getUserSession,
}));

vi.mock("@calcom/prisma", () => {
  const fake = {};
  return { default: fake, prisma: fake, readonlyPrisma: fake, availabilityUserSelect: {}, userSelect: {} };
});

vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn() }));

vi.mock("@calcom/features/organizations/di/TempOrgRedirectRepository.container", () => ({
  getTempOrgRedirectRepository: () => ({ disableByFrom: mocks.disableByFrom }),
}));

const tx = {
  user: { update: mocks.txUserUpdate },
  profile: { update: mocks.txProfileUpdate, updateMany: mocks.txProfileUpdateMany },
};

const ctx = {
  prisma: { user: { findUnique: mocks.findUnique }, $transaction: mocks.$transaction },
  insightsDb: {},
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
} as unknown as TRPCContextInner;

const createCaller = createCallerFactory(userAdminRouter);

const requestedUser = { id: 11, username: "old-name", organizationId: 5, movedToProfileId: null };

describe("admin users router update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.getUserSession.mockResolvedValue({
      user: { id: 1, role: "ADMIN" },
      session: { upId: "usr-1", expires: "2099-01-01T00:00:00.000Z", user: { id: 1 } },
    });
    mocks.findUnique.mockResolvedValue(requestedUser);
    mocks.txUserUpdate.mockResolvedValue({ id: 11 });
    mocks.txProfileUpdateMany.mockResolvedValue({ count: 1 });
    mocks.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      mocks.calls.push("transaction");
      return result;
    });
    mocks.disableByFrom.mockImplementation(async () => {
      mocks.calls.push("disableByFrom");
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables User redirects from the new username after the transaction", async () => {
    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).toHaveBeenCalledWith({ fromOrgId: 5, from: "new-name", types: ["User"] });
    expect(mocks.calls).toEqual(["transaction", "disableByFrom"]);
  });

  it("does not disable redirects when ORGANIZATIONS_ENABLED is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it("does not disable redirects for a user without an organization", async () => {
    mocks.findUnique.mockResolvedValue({ ...requestedUser, organizationId: null });

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no username", input: { userId: 11, name: "Renamed" } },
    { name: "the same username", input: { userId: 11, username: "old-name" } },
  ])("does not disable redirects with $name", async ({ input }) => {
    await createCaller(ctx).update(input);

    expect(mocks.$transaction).toHaveBeenCalled();
    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });
});
