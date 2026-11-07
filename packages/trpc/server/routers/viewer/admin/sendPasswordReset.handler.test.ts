import { beforeEach, describe, expect, it, vi } from "vitest";
import sendPasswordResetHandler from "./sendPasswordReset.handler";

const { prismaMock, getBaseUrlForUser, sendPasswordResetEmail } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn() },
    resetPasswordRequest: { create: vi.fn() },
  },
  getBaseUrlForUser: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForUser }),
}));
vi.mock("@calcom/emails/auth-email-service", () => ({ sendPasswordResetEmail }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn(async () => (key: string) => key) }));

const run = (userId: number) => sendPasswordResetHandler({ ctx: { user: {} as never }, input: { userId } });

describe("admin sendPasswordReset handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a reset link on the target user's organization base URL", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ name: "Ada", email: "ada@example.com", locale: "pl" });
    prismaMock.resetPasswordRequest.create.mockResolvedValue({ id: "reset-id" });
    getBaseUrlForUser.mockResolvedValue("https://org.example.com");

    await expect(run(42)).resolves.toEqual({ success: true });

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({ resetLink: "https://org.example.com/auth/forgot-password/reset-id" })
    );
  });

  it("throws for an unknown user", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(run(1)).rejects.toThrow("User not found");
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
