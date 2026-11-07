import { ErrorCode } from "@calcom/features/auth/lib/ErrorCode";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteMeWithoutPasswordHandler } from "./deleteMeWithoutPassword.handler";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));

vi.mock("@calcom/features/users/lib/deleteUser", () => ({ deleteUser: mocks.deleteUser }));

const ctx = { user: { id: 7, email: "Owner@Acme.com" } as NonNullable<TrpcSessionUser> };

const googleUser = {
  id: 7,
  email: "owner@acme.com",
  metadata: null,
  identityProvider: "GOOGLE",
  twoFactorEnabled: false,
};

describe("deleteMeWithoutPasswordHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteUser.mockResolvedValue(undefined);
  });

  it("deletes a social-login user through deleteUser", async () => {
    mocks.findUnique.mockResolvedValue(googleUser);

    await deleteMeWithoutPasswordHandler({ ctx });

    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "owner@acme.com" } });
    expect(mocks.deleteUser).toHaveBeenCalledWith(googleUser);
  });

  it("surfaces the last-owner refusal from deleteUser", async () => {
    mocks.findUnique.mockResolvedValue(googleUser);
    const refusal = ErrorWithCode.Factory.PreconditionFailed("organization_last_owner_cannot_be_deleted");
    mocks.deleteUser.mockRejectedValue(refusal);

    await expect(deleteMeWithoutPasswordHandler({ ctx })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "organization_last_owner_cannot_be_deleted",
    });
  });

  it.each([
    ["an unknown user", null, ErrorCode.UserNotFound],
    ["a password user", { ...googleUser, identityProvider: "CAL" }, ErrorCode.SocialIdentityProviderRequired],
    [
      "a user with two-factor auth",
      { ...googleUser, twoFactorEnabled: true },
      ErrorCode.SocialIdentityProviderRequired,
    ],
  ])("refuses %s without deleting", async (_label, found, message) => {
    mocks.findUnique.mockResolvedValue(found);

    await expect(deleteMeWithoutPasswordHandler({ ctx })).rejects.toThrow(message);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
});
