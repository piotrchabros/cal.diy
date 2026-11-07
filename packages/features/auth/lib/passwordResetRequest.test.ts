import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordResetRequest } from "./passwordResetRequest";

const { prismaMock, getBaseUrlForEmail, sendPasswordResetEmail } = vi.hoisted(() => ({
  prismaMock: {
    resetPasswordRequest: {
      updateMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
  getBaseUrlForEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForEmail }),
}));
vi.mock("@calcom/emails/auth-email-service", () => ({ sendPasswordResetEmail }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn(async () => (key: string) => key) }));

describe("passwordResetRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.resetPasswordRequest.count.mockResolvedValue(0);
    prismaMock.resetPasswordRequest.create.mockResolvedValue({ id: "reset-id" });
  });

  it("builds the reset link on the user's organization base URL", async () => {
    getBaseUrlForEmail.mockResolvedValue("https://org.example.com");

    await passwordResetRequest({ email: "ada@example.com", name: "Ada", locale: "en" });

    expect(getBaseUrlForEmail).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({ resetLink: "https://org.example.com/auth/forgot-password/reset-id" })
    );
  });

  it("refuses after too many recent attempts", async () => {
    prismaMock.resetPasswordRequest.count.mockResolvedValue(3);

    await expect(
      passwordResetRequest({ email: "ada@example.com", name: "Ada", locale: null })
    ).rejects.toThrow("Too many password reset attempts");
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
