import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../createContext";
import { createCallerFactory } from "../../../trpc";
import { userAdminRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  disableByFrom: vi.fn(),
  repointUserRedirectsForRename: vi.fn(),
  findUnique: vi.fn(),
  userUpdate: vi.fn(),
  changeUsername: vi.fn(),
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

vi.mock("@calcom/features/organizations/lib/repointUserRedirectsForRename", () => ({
  repointUserRedirectsForRename: mocks.repointUserRedirectsForRename,
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ changeUsername: mocks.changeUsername }),
}));

const ctx = {
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.userUpdate } },
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
    mocks.changeUsername.mockImplementation(async () => {
      mocks.calls.push("changeUsername");
    });
    mocks.userUpdate.mockImplementation(async () => {
      mocks.calls.push("userUpdate");
      return { id: 11 };
    });
    mocks.repointUserRedirectsForRename.mockImplementation(async () => {
      mocks.calls.push("repoint");
    });
    mocks.disableByFrom.mockImplementation(async () => {
      mocks.calls.push("disableByFrom");
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables User redirects from the new username after the update", async () => {
    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).toHaveBeenCalledWith({ fromOrgId: 5, from: "new-name", types: ["User"] });
    expect(mocks.calls).toEqual(["changeUsername", "userUpdate", "repoint", "disableByFrom"]);
  });

  it("repoints move redirects in the user's organization from the old to the new username", async () => {
    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.repointUserRedirectsForRename).toHaveBeenCalledWith({
      organizationId: 5,
      oldUsername: "old-name",
      newUsername: "new-name",
    });
  });

  it("renames the username through OrganizationMembershipService and updates the other fields without it", async () => {
    await createCaller(ctx).update({ userId: 11, username: "new-name", name: "Renamed" });

    expect(mocks.changeUsername).toHaveBeenCalledWith({ userId: 11, username: "new-name" });
    expect(mocks.userUpdate).toHaveBeenCalledWith({ where: { id: 11 }, data: { name: "Renamed" } });
  });

  it("routes a legacy moved-to user through changeUsername instead of renaming the profile directly", async () => {
    mocks.findUnique.mockResolvedValue({ ...requestedUser, movedToProfileId: 77 });

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.changeUsername).toHaveBeenCalledWith({ userId: 11, username: "new-name" });
    expect(mocks.calls).toEqual(["changeUsername", "userUpdate", "repoint", "disableByFrom"]);
  });

  it("calls changeUsername for an unchanged username so a missing org profile is created", async () => {
    await createCaller(ctx).update({ userId: 11, username: "old-name" });

    expect(mocks.changeUsername).toHaveBeenCalledWith({ userId: 11, username: "old-name" });
  });

  it("does not call changeUsername without a username", async () => {
    await createCaller(ctx).update({ userId: 11, name: "Renamed" });

    expect(mocks.changeUsername).not.toHaveBeenCalled();
    expect(mocks.userUpdate).toHaveBeenCalledWith({ where: { id: 11 }, data: { name: "Renamed" } });
  });

  it("clears the username directly when it is set to null", async () => {
    await createCaller(ctx).update({ userId: 11, username: null });

    expect(mocks.changeUsername).not.toHaveBeenCalled();
    expect(mocks.userUpdate).toHaveBeenCalledWith({ where: { id: 11 }, data: { username: null } });
  });

  it("maps a username conflict to a CONFLICT error and skips the other changes", async () => {
    mocks.changeUsername.mockRejectedValue(
      new ErrorWithCode(ErrorCode.Conflict, "Username is already taken in this organization")
    );

    await expect(
      createCaller(ctx).update({ userId: 11, username: "taken", name: "Renamed" })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Username is already taken in this organization" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.repointUserRedirectsForRename).not.toHaveBeenCalled();
  });

  it("rethrows other changeUsername errors unchanged", async () => {
    const failure = new Error("database down");
    mocks.changeUsername.mockRejectedValue(failure);

    await expect(createCaller(ctx).update({ userId: 11, username: "new-name" })).rejects.toMatchObject({
      cause: failure,
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
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

    expect(mocks.userUpdate).toHaveBeenCalled();
    expect(mocks.repointUserRedirectsForRename).not.toHaveBeenCalled();
    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });
});
