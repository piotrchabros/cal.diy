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
  findByIdWithOrganizationId: vi.fn(),
  findAll: vi.fn(),
  updateById: vi.fn(),
  changeUsername: vi.fn(),
  assertUserCanBeDeleted: vi.fn(),
  deleteById: vi.fn(),
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
  getOrganizationMembershipService: () => ({
    changeUsername: mocks.changeUsername,
    assertUserCanBeDeleted: mocks.assertUserCanBeDeleted,
  }),
}));

vi.mock("@calcom/features/di/containers/UserRepository", () => ({
  getUserRepository: () => ({
    findByIdWithOrganizationId: mocks.findByIdWithOrganizationId,
    findAll: mocks.findAll,
    updateById: mocks.updateById,
    deleteById: mocks.deleteById,
  }),
}));

const ctx = {} as unknown as TRPCContextInner;

const createCaller = createCallerFactory(userAdminRouter);

const requestedUser = { id: 11, username: "old-name", organizationId: 5 };

const mockAdminSession = () =>
  mocks.getUserSession.mockResolvedValue({
    user: { id: 1, role: "ADMIN" },
    session: { upId: "usr-1", expires: "2099-01-01T00:00:00.000Z", user: { id: 1 } },
  });

describe("admin users router get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminSession();
    mocks.findByIdWithOrganizationId.mockResolvedValue(requestedUser);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the requested user from the repository", async () => {
    await expect(createCaller(ctx).get({ userId: 11 })).resolves.toEqual({ user: requestedUser });

    expect(mocks.findByIdWithOrganizationId).toHaveBeenCalledWith({ id: 11 });
  });

  it("answers NOT_FOUND when the repository has no such user", async () => {
    mocks.findByIdWithOrganizationId.mockResolvedValue(null);

    await expect(createCaller(ctx).get({ userId: 404 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "User not found",
    });
  });

  it("answers BAD_REQUEST without a user id", async () => {
    await expect(createCaller(ctx).get({} as { userId: number })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "User id is required",
    });
    expect(mocks.findByIdWithOrganizationId).not.toHaveBeenCalled();
  });
});

describe("admin users router list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminSession();
    mocks.findAll.mockResolvedValue([requestedUser]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the repository rows without full prisma rows", async () => {
    await expect(createCaller(ctx).list()).resolves.toEqual([requestedUser]);

    expect(mocks.findAll).toHaveBeenCalledOnce();
  });
});

describe("admin users router update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockAdminSession();
    mocks.findByIdWithOrganizationId.mockResolvedValue(requestedUser);
    mocks.changeUsername.mockImplementation(async () => {
      mocks.calls.push("changeUsername");
    });
    mocks.updateById.mockImplementation(async () => {
      mocks.calls.push("updateById");
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
    expect(mocks.calls).toEqual(["changeUsername", "updateById", "repoint", "disableByFrom"]);
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
    expect(mocks.updateById).toHaveBeenCalledWith({ id: 11, data: { name: "Renamed" } });
  });

  it("routes a legacy moved-to user through changeUsername instead of renaming the profile directly", async () => {
    mocks.findByIdWithOrganizationId.mockResolvedValue({ ...requestedUser, movedToProfileId: 77 });

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.changeUsername).toHaveBeenCalledWith({ userId: 11, username: "new-name" });
    expect(mocks.calls).toEqual(["changeUsername", "updateById", "repoint", "disableByFrom"]);
  });

  it("calls changeUsername for an unchanged username so a missing org profile is created", async () => {
    await createCaller(ctx).update({ userId: 11, username: "old-name" });

    expect(mocks.changeUsername).toHaveBeenCalledWith({ userId: 11, username: "old-name" });
  });

  it("does not call changeUsername without a username", async () => {
    await createCaller(ctx).update({ userId: 11, name: "Renamed" });

    expect(mocks.changeUsername).not.toHaveBeenCalled();
    expect(mocks.updateById).toHaveBeenCalledWith({ id: 11, data: { name: "Renamed" } });
  });

  it("clears the username directly when it is set to null", async () => {
    await createCaller(ctx).update({ userId: 11, username: null });

    expect(mocks.changeUsername).not.toHaveBeenCalled();
    expect(mocks.updateById).toHaveBeenCalledWith({ id: 11, data: { username: null } });
  });

  it("maps a username conflict to a CONFLICT error and skips the other changes", async () => {
    mocks.changeUsername.mockRejectedValue(
      new ErrorWithCode(ErrorCode.Conflict, "username_taken_in_organization")
    );

    await expect(
      createCaller(ctx).update({ userId: 11, username: "taken", name: "Renamed" })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "username_taken_in_organization" });
    expect(mocks.updateById).not.toHaveBeenCalled();
    expect(mocks.repointUserRedirectsForRename).not.toHaveBeenCalled();
  });

  it("rethrows other changeUsername errors unchanged", async () => {
    const failure = new Error("database down");
    mocks.changeUsername.mockRejectedValue(failure);

    await expect(createCaller(ctx).update({ userId: 11, username: "new-name" })).rejects.toMatchObject({
      cause: failure,
    });
    expect(mocks.updateById).not.toHaveBeenCalled();
  });

  it("does not disable redirects when ORGANIZATIONS_ENABLED is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it("does not disable redirects for a user without an organization", async () => {
    mocks.findByIdWithOrganizationId.mockResolvedValue({ ...requestedUser, organizationId: null });

    await createCaller(ctx).update({ userId: 11, username: "new-name" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no username", input: { userId: 11, name: "Renamed" } },
    { name: "the same username", input: { userId: 11, username: "old-name" } },
  ])("does not disable redirects with $name", async ({ input }) => {
    await createCaller(ctx).update(input);

    expect(mocks.updateById).toHaveBeenCalled();
    expect(mocks.repointUserRedirectsForRename).not.toHaveBeenCalled();
    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });
});

describe("admin users router delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminSession();
    mocks.findByIdWithOrganizationId.mockResolvedValue(requestedUser);
    mocks.assertUserCanBeDeleted.mockResolvedValue(undefined);
    mocks.deleteById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deletes the user through the repository after the last-owner check", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await expect(createCaller(ctx).delete({ userId: 11 })).resolves.toEqual({
      message: "User with id: 11 deleted successfully",
    });

    expect(mocks.assertUserCanBeDeleted).toHaveBeenCalledWith(11);
    expect(mocks.deleteById).toHaveBeenCalledWith({ id: 11 });
  });

  it("answers PRECONDITION_FAILED with the translatable key for the last owner", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.assertUserCanBeDeleted.mockRejectedValue(
      ErrorWithCode.Factory.PreconditionFailed("organization_last_owner_cannot_be_deleted")
    );

    await expect(createCaller(ctx).delete({ userId: 11 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "organization_last_owner_cannot_be_deleted",
    });
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it("deletes without the organization check while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");

    await createCaller(ctx).delete({ userId: 11 });

    expect(mocks.assertUserCanBeDeleted).not.toHaveBeenCalled();
    expect(mocks.deleteById).toHaveBeenCalledWith({ id: 11 });
  });
});
