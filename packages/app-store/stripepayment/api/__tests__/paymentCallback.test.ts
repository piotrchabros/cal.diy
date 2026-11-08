import { WEBAPP_URL } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCustomerAndCheckoutSession } from "../../lib/getCustomerAndCheckoutSession";
import { VerificationTokenService } from "../../lib/VerificationTokenService";
import type {
  AssignPremiumUsername,
  GetPaymentCallbackBaseUrl,
  SendVerificationRequest,
} from "../paymentCallback";

// Mock dependencies
vi.mock("@calcom/prisma", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../lib/getCustomerAndCheckoutSession");
vi.mock("../../lib/VerificationTokenService", () => ({
  VerificationTokenService: {
    create: vi.fn(),
  },
}));

const mockGetCustomerAndCheckoutSession = vi.mocked(getCustomerAndCheckoutSession);
const mockSendVerificationRequest = vi.fn<SendVerificationRequest>();
const mockVerificationTokenServiceCreate = vi.mocked(VerificationTokenService.create);

// Type the mocked prisma properly
const mockPrisma = prisma as unknown as {
  user: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

async function buildHandler(assignUsername?: AssignPremiumUsername, getBaseUrl?: GetPaymentCallbackBaseUrl) {
  const { createPaymentCallbackHandler } = await import("../paymentCallback");
  return createPaymentCallbackHandler({
    sendVerificationRequest: mockSendVerificationRequest,
    assignUsername,
    getBaseUrl,
  });
}

describe("paymentCallback", () => {
  let mockReq: Partial<NextApiRequest>;
  let mockRes: Partial<NextApiResponse>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      query: {
        callbackUrl: "/premium-username-checkout",
        checkoutSessionId: "cs_test_123",
      },
      url: "/api/payment/callback",
      method: "GET",
    };

    mockRes = {
      redirect: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    // Default mock implementations
    mockGetCustomerAndCheckoutSession.mockResolvedValue({
      stripeCustomer: {
        id: "cus_123",
        email: "test@example.com",
        metadata: {
          username: "premium-user",
        },
      },
      checkoutSession: {
        payment_status: "paid",
      },
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    mockPrisma.user.findFirst.mockResolvedValue({
      id: 1,
      email: "test@example.com",
      locale: "en",
      metadata: {},
      organizationId: 5,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    mockPrisma.user.update.mockResolvedValue({
      id: 1,
      username: "premium-user",
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    mockVerificationTokenServiceCreate.mockResolvedValue("test-token-123");
    mockSendVerificationRequest.mockResolvedValue(undefined);
  });

  describe("VerificationTokenService integration", () => {
    it("should call VerificationTokenService.create with correct parameters", async () => {
      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockVerificationTokenServiceCreate).toHaveBeenCalledWith({
        identifier: "test@example.com",
        expires: expect.any(Date),
      });

      const callArgs = mockVerificationTokenServiceCreate.mock.calls[0][0];
      const expiresDate = callArgs.expires;
      const now = Date.now();
      const oneDayInMs = 86400 * 1000;

      // Verify expires is approximately 1 day from now (within 1 second tolerance)
      expect(expiresDate.getTime()).toBeGreaterThan(now);
      expect(expiresDate.getTime()).toBeLessThanOrEqual(now + oneDayInMs + 1000);
    });

    it("should send verification email with token from service", async () => {
      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockSendVerificationRequest).toHaveBeenCalledWith({
        identifier: "test@example.com",
        url: expect.stringContaining("token=test-token-123"),
      });
    });

    it("should create verification token before sending email", async () => {
      const handler = await buildHandler();
      const callOrder: string[] = [];

      mockVerificationTokenServiceCreate.mockImplementation(async function () {
        callOrder.push("create-token");
        return "test-token";
      });

      mockSendVerificationRequest.mockImplementation(async () => {
        callOrder.push("send-email");
      });

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(callOrder).toEqual(["create-token", "send-email"]);
    });

    it("should create verification token only after payment is confirmed", async () => {
      mockGetCustomerAndCheckoutSession.mockResolvedValue({
        stripeCustomer: {
          id: "cus_123",
          email: "test@example.com",
          metadata: { username: "premium-user" },
        },
        checkoutSession: {
          payment_status: "unpaid",
        },
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockVerificationTokenServiceCreate).not.toHaveBeenCalled();
      expect(mockSendVerificationRequest).not.toHaveBeenCalled();
    });

    it("should handle user found by stripeCustomerId", async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null) // First call by email returns null
        .mockResolvedValueOnce({
          // Second call by stripeCustomerId succeeds
          id: 2,
          email: "different@example.com",
          locale: "en",
          metadata: { stripeCustomerId: "cus_123" },
          organizationId: 5,
        } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockVerificationTokenServiceCreate).toHaveBeenCalledWith({
        identifier: "different@example.com", // Should use user.email from found user
        expires: expect.any(Date),
      });
    });

    it("should update user with premium username before creating token", async () => {
      const handler = await buildHandler();
      const callOrder: string[] = [];

      mockPrisma.user.update.mockImplementation(async () => {
        callOrder.push("update-user");
        return {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      });

      mockVerificationTokenServiceCreate.mockImplementation(async function () {
        callOrder.push("create-token");
        return "token";
      });

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(callOrder).toEqual(["update-user", "update-user", "create-token"]);
    });

    it("should redirect with correct parameters after successful payment", async () => {
      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0] as string;
      expect(redirectUrl).toContain("email=test%40example.com");
      expect(redirectUrl).toContain("username=premium-user");
      expect(redirectUrl).toContain("paymentStatus=paid");
    });

    it("should not create verification token when stripe customer is not found", async () => {
      mockGetCustomerAndCheckoutSession.mockResolvedValue({
        stripeCustomer: null,
        checkoutSession: { payment_status: "paid" },
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Stripe customer not found or deleted") })
      );
      expect(mockVerificationTokenServiceCreate).not.toHaveBeenCalled();
      expect(mockSendVerificationRequest).not.toHaveBeenCalled();
    });

    it("should not create verification token when user is not found", async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);

      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ message: "User not found" }));
      expect(mockVerificationTokenServiceCreate).not.toHaveBeenCalled();
      expect(mockSendVerificationRequest).not.toHaveBeenCalled();
    });

    it("should use user email if stripe customer email is missing", async () => {
      mockGetCustomerAndCheckoutSession.mockResolvedValue({
        stripeCustomer: {
          id: "cus_123",
          email: null,
          metadata: { username: "premium-user" },
        },
        checkoutSession: { payment_status: "paid" },
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockVerificationTokenServiceCreate).toHaveBeenCalledWith({
        identifier: "test@example.com", // Should use user.email
        expires: expect.any(Date),
      });
    });
  });

  describe("premium username assignment", () => {
    it("default handler writes the username, then the isPremium metadata", async () => {
      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(mockPrisma.user.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.user.update).toHaveBeenNthCalledWith(1, {
        where: { id: 1 },
        data: { username: "premium-user" },
        select: { id: true },
      });
      expect(mockPrisma.user.update).toHaveBeenNthCalledWith(2, {
        where: { id: 1 },
        data: { metadata: { isPremium: true } },
        select: { id: true },
      });
    });

    it("injected assigner receives the organization and the username is not written through prisma", async () => {
      const assignUsername = vi.fn().mockResolvedValue(undefined);
      const handler = await buildHandler(assignUsername);

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(assignUsername).toHaveBeenCalledWith({ userId: 1, organizationId: 5, username: "premium-user" });
      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { metadata: { isPremium: true } },
        select: { id: true },
      });
    });

    it("a refused username gives a 400 and does not mark the user premium", async () => {
      const assignUsername = vi.fn().mockRejectedValue(new Error("username taken"));
      const handler = await buildHandler(assignUsername);

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      // defaultResponder turns the thrown HttpError into the response status
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("premium username could still not be reserved"),
        })
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockVerificationTokenServiceCreate).not.toHaveBeenCalled();
    });

    it("an unpaid checkout does not assign the username", async () => {
      mockGetCustomerAndCheckoutSession.mockResolvedValue({
        stripeCustomer: {
          id: "cus_123",
          email: "test@example.com",
          metadata: { username: "premium-user" },
        },
        checkoutSession: { payment_status: "unpaid" },
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      const assignUsername = vi.fn().mockResolvedValue(undefined);
      const handler = await buildHandler(assignUsername);

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(assignUsername).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe("organization base URL", () => {
    const orgBaseUrl = "https://acme.example.org";

    it("resolves a relative callbackUrl and the magic-login link on the buyer's organization domain", async () => {
      const getBaseUrl = vi.fn(async () => orgBaseUrl);
      const handler = await buildHandler(undefined, getBaseUrl);

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: 5 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0] as string;
      expect(redirectUrl.startsWith(`${orgBaseUrl}/premium-username-checkout`)).toBe(true);

      expect(mockSendVerificationRequest).toHaveBeenCalledWith({
        identifier: "test@example.com",
        url: expect.stringMatching(
          new RegExp(
            `^${orgBaseUrl.replace(/\./g, "\\.")}/api/auth/callback/email\\?.*callbackUrl=${encodeURIComponent(
              orgBaseUrl
            )}`
          )
        ),
      });
    });

    it("keeps an absolute callbackUrl while the magic link still uses the organization domain", async () => {
      const getBaseUrl = vi.fn(async () => orgBaseUrl);
      const handler = await buildHandler(undefined, getBaseUrl);
      mockReq.query = {
        callbackUrl: "https://app.example.com/premium-username-checkout",
        checkoutSessionId: "cs_test_123",
      };

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0] as string;
      expect(redirectUrl.startsWith("https://app.example.com/premium-username-checkout")).toBe(true);
      expect(mockSendVerificationRequest).toHaveBeenCalledWith({
        identifier: "test@example.com",
        url: expect.stringContaining(`${orgBaseUrl}/api/auth/callback/email?`),
      });
    });

    it("falls back to WEBAPP_URL without an injected base URL", async () => {
      const handler = await buildHandler();

      await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0] as string;
      expect(redirectUrl.startsWith(`${WEBAPP_URL}/premium-username-checkout`)).toBe(true);
      expect(mockSendVerificationRequest).toHaveBeenCalledWith({
        identifier: "test@example.com",
        url: expect.stringContaining(`${WEBAPP_URL}/api/auth/callback/email?`),
      });
    });
  });
});
