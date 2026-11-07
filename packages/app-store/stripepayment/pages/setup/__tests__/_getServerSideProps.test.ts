import type { GetServerSidePropsContext } from "next";
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports
vi.mock("@calcom/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../../../lib/getStripeAppKeys", () => ({
  getStripeAppKeys: vi.fn(),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  WEBAPP_URL: "https://app.cal.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.cal.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"],
}));

import process from "node:process";
import prisma from "@calcom/prisma";
import type { AppSetupPageDeps } from "../../../../_pages/setup/types";
import { getStripeAppKeys } from "../../../lib/getStripeAppKeys";
import { getServerSideProps } from "../_getServerSideProps";

const mockGetServerSession = vi.fn<AppSetupPageDeps["getServerSession"]>();
const deps: AppSetupPageDeps = { getServerSession: mockGetServerSession };
const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
  };
};
const mockGetStripeAppKeys = vi.mocked(getStripeAppKeys);

function buildSession(uuid: string): Session {
  return {
    user: { id: 1, uuid },
    hasValidLicense: true,
    upId: "test",
    expires: "2024-12-31",
  };
}

function createMockContext(overrides: Partial<GetServerSidePropsContext> = {}): GetServerSidePropsContext {
  return {
    req: { headers: {} } as GetServerSidePropsContext["req"],
    res: {} as GetServerSidePropsContext["res"],
    params: { slug: "stripe" },
    query: {},
    resolvedUrl: "/apps/stripe/setup",
    ...overrides,
  };
}

describe("Stripe Setup Page getServerSideProps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStripeAppKeys.mockResolvedValue({
      client_id: "ca_test_client_id",
      payment_fee_fixed: 0,
      payment_fee_percentage: 0,
      public_key: "pk_test",
      webhook_secret: "whsec_test",
    });
  });

  describe("Slug validation", () => {
    it("should return notFound when slug is not a string", async () => {
      const ctx = createMockContext({ params: {} });

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({ notFound: true });
    });

    it("should return notFound when params is undefined", async () => {
      const ctx = createMockContext({ params: undefined });

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({ notFound: true });
    });
  });

  describe("Authentication validation", () => {
    it("should redirect to login when user is not authenticated", async () => {
      const ctx = createMockContext();
      mockGetServerSession.mockResolvedValue(null);

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({
        redirect: {
          destination: "/auth/login",
          permanent: false,
        },
      });
      expect(mockGetServerSession).toHaveBeenCalledWith({ req: ctx.req });
    });

    it("should redirect to login when session has no user uuid", async () => {
      const ctx = createMockContext();
      mockGetServerSession.mockResolvedValue(buildSession(""));

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({
        redirect: {
          destination: "/auth/login",
          permanent: false,
        },
      });
    });
  });

  describe("User lookup", () => {
    it("should return notFound when user does not exist in database", async () => {
      const ctx = createMockContext();
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      mockGetServerSession.mockResolvedValue(buildSession(testUuid));
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({ notFound: true });
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { uuid: testUuid },
        select: { email: true, name: true },
      });
    });
  });

  describe("OAuth redirect construction", () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue(buildSession("550e8400-e29b-41d4-a716-446655440000"));
      mockPrisma.user.findUnique.mockResolvedValue({
        email: "user@example.com",
        name: "Test User",
      });
    });

    it("should redirect to Stripe OAuth with correct parameters", async () => {
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      expect(result).toHaveProperty("redirect");
      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.permanent).toBe(false);
      expect(redirect.destination).toContain("https://connect.stripe.com/oauth/authorize");
      expect(redirect.destination).toContain("client_id=ca_test_client_id");
      expect(redirect.destination).toContain("scope=read_write");
      expect(redirect.destination).toContain("response_type=code");
    });

    it("should include user email in stripe_user params", async () => {
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.destination).toContain(encodeURIComponent("user@example.com"));
    });

    it("should include user first name in stripe_user params", async () => {
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.destination).toContain("first_name");
    });

    it("should include correct redirect_uri", async () => {
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.destination).toContain(
        encodeURIComponent("https://app.cal.com/api/integrations/stripepayment/callback")
      );
    });

    it("should use the organization domain for redirect_uri when organizations are enabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      try {
        const ctx = createMockContext({
          req: { headers: { host: "acme.example.org" } } as GetServerSidePropsContext["req"],
        });

        const result = await getServerSideProps(ctx, deps);

        const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
        expect(redirect.destination).toContain(
          encodeURIComponent("https://acme.example.org/api/integrations/stripepayment/callback")
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should include state with default onErrorReturnTo when not provided", async () => {
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      // State should contain fromApp: true and default onErrorReturnTo
      const stateMatch = redirect.destination.match(/state=([^&]+)/);
      expect(stateMatch).toBeTruthy();
      const stateStr = decodeURIComponent(stateMatch![1]);
      const state = JSON.parse(stateStr);
      expect(state.fromApp).toBe(true);
      expect(state.onErrorReturnTo).toBe("https://app.cal.com/apps/installed/payment");
      expect(state.returnTo).toBeUndefined();
    });

    it("should include returnTo in state when provided", async () => {
      const ctx = createMockContext({
        query: { returnTo: "/event-types/123" },
      });

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      const stateMatch = redirect.destination.match(/state=([^&]+)/);
      const stateStr = decodeURIComponent(stateMatch![1]);
      const state = JSON.parse(stateStr);
      expect(state.returnTo).toBe("/event-types/123");
    });

    it("should use custom onErrorReturnTo when provided", async () => {
      const ctx = createMockContext({
        query: { onErrorReturnTo: "/settings/integrations" },
      });

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      const stateMatch = redirect.destination.match(/state=([^&]+)/);
      const stateStr = decodeURIComponent(stateMatch![1]);
      const state = JSON.parse(stateStr);
      expect(state.onErrorReturnTo).toBe("/settings/integrations");
    });

    it("should handle user with null name", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        email: "user@example.com",
        name: null,
      });
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      expect(result).toHaveProperty("redirect");
      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.destination).toContain("https://connect.stripe.com/oauth/authorize");
    });
  });

  describe("Error handling", () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue(buildSession("550e8400-e29b-41d4-a716-446655440000"));
      mockPrisma.user.findUnique.mockResolvedValue({
        email: "user@example.com",
        name: "Test User",
      });
    });

    it("should redirect to error page when getStripeAppKeys fails", async () => {
      mockGetStripeAppKeys.mockRejectedValue(new Error("Failed to get Stripe keys"));
      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      expect(result).toEqual({
        redirect: {
          destination: "https://app.cal.com/apps/installed/payment?error=stripe_oauth_failed",
          permanent: false,
        },
      });
    });
  });

  describe("E2E mode", () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue(buildSession("550e8400-e29b-41d4-a716-446655440000"));
      mockPrisma.user.findUnique.mockResolvedValue({
        email: "user@example.com",
        name: "Test User",
      });
    });

    it("should include country=US when NEXT_PUBLIC_IS_E2E is set", async () => {
      const originalEnv = process.env.NEXT_PUBLIC_IS_E2E;
      process.env.NEXT_PUBLIC_IS_E2E = "true";

      const ctx = createMockContext();

      const result = await getServerSideProps(ctx, deps);

      const redirect = (result as { redirect: { destination: string; permanent: boolean } }).redirect;
      expect(redirect.destination).toContain("country");

      process.env.NEXT_PUBLIC_IS_E2E = originalEnv;
    });
  });
});
