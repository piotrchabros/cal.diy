import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customersRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  usernameCheck: vi.fn(),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"],
}));

vi.mock("../../lib/server", () => ({
  default: {
    customers: { retrieve: mocks.customersRetrieve, update: mocks.customersUpdate },
    checkout: { sessions: { create: mocks.checkoutSessionsCreate } },
  },
}));
vi.mock("../../lib/customer");
vi.mock("@calcom/prisma", () => ({
  default: { user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate } },
}));
vi.mock("@calcom/lib/server/username", () => ({ usernameCheck: mocks.usernameCheck }));
vi.mock("@calcom/app-store/stripepayment/lib/utils", () => ({
  getPremiumMonthlyPlanPriceId: () => "price_premium",
}));

import * as customerModule from "../../lib/customer";
import handler from "../subscription";

const mockCustomerModule = vi.mocked(customerModule);

const buildRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const buildReq = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: { intentUsername: "premium", callbackUrl: "/settings" },
    session: { user: { id: 42 } },
    headers: {},
    ...overrides,
  }) as unknown as NextApiRequest;

describe("stripepayment subscription handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomerModule.getStripeCustomerIdFromUserId.mockResolvedValue("cus_123");
    mocks.userFindFirst.mockResolvedValue({ id: 42, metadata: { foo: "bar" } });
    mocks.usernameCheck.mockResolvedValue({ available: true });
    mocks.customersRetrieve.mockResolvedValue({ id: "cus_123", deleted: false, metadata: { a: "1" } });
    mocks.checkoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });
  });

  it("returns 404 when there is no session on the request", async () => {
    const res = buildRes();
    await handler(buildReq({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: "Missing required parameters: userId or intentUsername",
    });
    expect(mockCustomerModule.getStripeCustomerIdFromUserId).not.toHaveBeenCalled();
  });

  it("returns 404 when intentUsername is missing", async () => {
    const res = buildRes();
    await handler(buildReq({ query: {} }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: "Missing required parameters: userId or intentUsername",
    });
  });

  it("uses the session user id for the customer lookup and checkout metadata", async () => {
    const res = buildRes();
    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(mockCustomerModule.getStripeCustomerIdFromUserId).toHaveBeenCalledWith(42);
    expect(mocks.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42 } }));
    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_123",
        metadata: { userId: "42", intentUsername: "premium" },
      })
    );
  });

  it("updates the customer and user, then redirects to the checkout session url", async () => {
    const res = buildRes();
    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(mocks.customersUpdate).toHaveBeenCalledWith("cus_123", {
      metadata: { a: "1", username: "premium" },
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { metadata: { foo: "bar", isPremium: false } },
    });
    expect(res.redirect).toHaveBeenCalledWith("https://checkout.stripe.com/session");
    expect(res.end).toHaveBeenCalled();
  });

  it("returns 404 when the intent username is not available", async () => {
    mocks.usernameCheck.mockResolvedValue({ available: false });
    const res = buildRes();
    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "Intent username not available" });
    expect(mocks.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("does nothing for non-GET requests", async () => {
    const res = buildRes();
    await handler(buildReq({ method: "POST" }), res as unknown as NextApiResponse);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(mockCustomerModule.getStripeCustomerIdFromUserId).not.toHaveBeenCalled();
  });

  it("builds the Stripe return URL on the default domain", async () => {
    const res = buildRes();
    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: expect.stringMatching(
          /^https:\/\/app\.example\.com\/api\/integrations\/stripepayment\/paymentCallback\?/
        ),
        cancel_url: expect.stringMatching(
          /^https:\/\/app\.example\.com\/api\/integrations\/stripepayment\/paymentCallback\?/
        ),
      })
    );
  });

  it("builds the Stripe return URL on the organization domain when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    try {
      const res = buildRes();
      await handler(buildReq({ headers: { host: "acme.example.org" } }), res as unknown as NextApiResponse);

      expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: expect.stringMatching(
            /^https:\/\/acme\.example\.org\/api\/integrations\/stripepayment\/paymentCallback\?/
          ),
          cancel_url: expect.stringMatching(
            /^https:\/\/acme\.example\.org\/api\/integrations\/stripepayment\/paymentCallback\?/
          ),
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("URL-encodes an absolute callbackUrl carrying its own query string", async () => {
    const res = buildRes();
    const callbackUrl = "https://acme.example.org/settings?tab=billing&ref=premium";
    await handler(
      buildReq({ query: { intentUsername: "premium", callbackUrl } }),
      res as unknown as NextApiResponse
    );

    const successUrl = mocks.checkoutSessionsCreate.mock.calls[0][0].success_url as string;
    // The whole callbackUrl must survive as one query param of the Stripe return URL.
    expect(new URL(successUrl).searchParams.get("callbackUrl")).toBe(callbackUrl);
    expect(successUrl).toContain(`callbackUrl=${encodeURIComponent(callbackUrl)}`);
    expect(successUrl).toContain("checkoutSessionId={CHECKOUT_SESSION_ID}");
  });

  it("uses the first callbackUrl when the query param repeats", async () => {
    const res = buildRes();
    await handler(
      buildReq({ query: { intentUsername: "premium", callbackUrl: ["/first", "/second"] } }),
      res as unknown as NextApiResponse
    );

    const successUrl = mocks.checkoutSessionsCreate.mock.calls[0][0].success_url as string;
    expect(new URL(successUrl).searchParams.get("callbackUrl")).toBe("/first");
  });

  it("ignores the organization host while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
    try {
      const res = buildRes();
      await handler(buildReq({ headers: { host: "acme.example.org" } }), res as unknown as NextApiResponse);

      expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: expect.stringMatching(/^https:\/\/app\.example\.com\//),
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
