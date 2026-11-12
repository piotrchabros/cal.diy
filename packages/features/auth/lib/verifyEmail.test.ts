import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendChangeOfEmailVerification, sendEmailVerification } from "./verifyEmail";

const { prismaMock, getBaseUrlForEmail, getBaseUrlForUser, emails } = vi.hoisted(() => ({
  prismaMock: { verificationToken: { create: vi.fn() } },
  getBaseUrlForEmail: vi.fn(),
  getBaseUrlForUser: vi.fn(),
  emails: {
    sendEmailVerificationLink: vi.fn(),
    sendChangeOfEmailVerificationLink: vi.fn(),
    sendEmailVerificationCode: vi.fn(),
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForEmail, getBaseUrlForUser }),
}));
vi.mock("@calcom/emails/auth-email-service", () => emails);
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn(async () => (key: string) => key) }));
vi.mock("@calcom/features/flags/features.repository", () => ({
  FeaturesRepository: class {
    checkIfFeatureIsEnabledGlobally = vi.fn().mockResolvedValue(true);
  },
}));
vi.mock("@calcom/features/watchlist/operations/check-if-email-in-watchlist.controller", () => ({
  checkIfEmailIsBlockedInWatchlistController: vi.fn().mockResolvedValue(false),
}));
vi.mock("@calcom/features/watchlist/lib/telemetry", () => ({ sentrySpan: {} }));
vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({ checkRateLimitAndThrowError: vi.fn() }));

describe("verifyEmail links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBaseUrlForEmail.mockResolvedValue("https://org.example.com");
  });

  it("sends the verification link on the account's organization base URL", async () => {
    await expect(sendEmailVerification({ email: "ada@example.com", username: "ada" })).resolves.toEqual({
      ok: true,
      skipped: false,
    });

    expect(getBaseUrlForEmail).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(getBaseUrlForUser).not.toHaveBeenCalled();
    expect(emails.sendEmailVerificationLink).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationEmailLink: expect.stringMatching(
          /^https:\/\/org\.example\.com\/api\/auth\/verify-email\?token=/
        ),
      })
    );
  });

  it("sends a secondary email's verification link on the owning user's organization base URL", async () => {
    getBaseUrlForUser.mockResolvedValue("https://user-org.example.com");

    await sendEmailVerification({
      email: "ada+work@example.com",
      username: "ada",
      userId: 42,
      secondaryEmailId: 9,
    });

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(getBaseUrlForEmail).not.toHaveBeenCalled();
    expect(emails.sendEmailVerificationLink).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationEmailLink: expect.stringMatching(
          /^https:\/\/user-org\.example\.com\/api\/auth\/verify-email\?token=/
        ),
        isSecondaryEmailVerification: true,
      })
    );
  });

  it("scopes the sender to the user when a userId is given", async () => {
    await sendEmailVerification({ email: "ada+work@example.com", username: "ada", userId: 42 });

    expect(emails.sendEmailVerificationLink).toHaveBeenCalledWith(
      expect.objectContaining({ senderScope: { userId: 42 } })
    );
  });

  it("sends the change-of-email link on the current address's organization base URL", async () => {
    await sendChangeOfEmailVerification({
      user: { username: "ada", emailFrom: "ada@example.com", emailTo: "new@example.com" },
    });

    expect(getBaseUrlForEmail).toHaveBeenCalledWith({ email: "ada@example.com" });
    expect(emails.sendChangeOfEmailVerificationLink).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationEmailLink: expect.stringMatching(
          /^https:\/\/org\.example\.com\/auth\/verify-email-change\?token=/
        ),
      })
    );
  });
});
