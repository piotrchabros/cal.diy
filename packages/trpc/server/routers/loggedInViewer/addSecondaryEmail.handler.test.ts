import { prisma } from "@calcom/prisma/__mocks__/prisma";
import { sendEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import type { SecondaryEmail, User } from "@calcom/prisma/client";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSecondaryEmailHandler } from "./addSecondaryEmail.handler";

vi.mock("@calcom/prisma", () => ({
  prisma,
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/verifyEmail", () => ({
  sendEmailVerification: vi.fn(),
}));

type SessionUser = NonNullable<TrpcSessionUser>;

const buildUser = (overrides: Partial<Pick<SessionUser, "id" | "username" | "locale">> = {}): SessionUser =>
  ({ id: 1, username: "alice", locale: "en", ...overrides }) as SessionUser;

const secondaryEmail: SecondaryEmail = {
  id: 10,
  userId: 1,
  email: "alice+2@example.com",
  emailVerified: null,
};

describe("addSecondaryEmail.handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the secondary email and sends verification linked to the user", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.secondaryEmail.findUnique.mockResolvedValue(null);
    prisma.secondaryEmail.create.mockResolvedValue(secondaryEmail);

    const response = await addSecondaryEmailHandler({
      ctx: { user: buildUser() },
      input: { email: secondaryEmail.email },
    });

    expect(prisma.secondaryEmail.create).toHaveBeenCalledWith({
      data: { email: secondaryEmail.email, userId: 1 },
    });
    expect(sendEmailVerification).toHaveBeenCalledWith({
      email: secondaryEmail.email,
      username: "alice",
      language: "en",
      secondaryEmailId: secondaryEmail.id,
      userId: 1,
    });
    expect(response).toEqual({ data: secondaryEmail, message: "Secondary email added successfully" });
  });

  it("passes extraParams when makePrimary and redirectTo are set", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.secondaryEmail.findUnique.mockResolvedValue(null);
    prisma.secondaryEmail.create.mockResolvedValue(secondaryEmail);

    await addSecondaryEmailHandler({
      ctx: { user: buildUser() },
      input: { email: secondaryEmail.email, makePrimary: true, redirectTo: "/settings/my-account/profile" },
    });

    expect(sendEmailVerification).toHaveBeenCalledWith({
      email: secondaryEmail.email,
      username: "alice",
      language: "en",
      secondaryEmailId: secondaryEmail.id,
      userId: 1,
      extraParams: { makePrimary: "true", redirectTo: "/settings/my-account/profile" },
    });
  });

  it("rejects an email already used as a primary email", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 2 } as User);

    await expect(
      addSecondaryEmailHandler({ ctx: { user: buildUser() }, input: { email: "taken@example.com" } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Email already taken" });

    expect(prisma.secondaryEmail.create).not.toHaveBeenCalled();
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects an email already used as a secondary email", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.secondaryEmail.findUnique.mockResolvedValue({ ...secondaryEmail, userId: 2 });

    await expect(
      addSecondaryEmailHandler({ ctx: { user: buildUser() }, input: { email: secondaryEmail.email } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Email already taken" });

    expect(prisma.secondaryEmail.create).not.toHaveBeenCalled();
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });
});
