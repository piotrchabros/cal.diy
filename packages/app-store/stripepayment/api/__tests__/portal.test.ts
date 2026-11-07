import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"] as string[],
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  ...constants,
}));

import {
  BillingPortalServiceFactory,
  TeamBillingPortalService,
  UserBillingPortalService,
} from "../../lib/BillingPortalService";
import * as customerModule from "../../lib/customer";
import handler, { buildReturnUrl, validateAuthentication } from "../portal";

// Mock dependencies
vi.mock("../../lib/customer");
vi.mock("../../lib/server");
vi.mock("../../lib/subscriptions");
vi.mock("@calcom/prisma", () => ({
  default: {},
}));

const mockCustomerModule = vi.mocked(customerModule);

interface RequestWithSession extends NextApiRequest {
  session?: Session | null;
}

const APP_DEFAULT = "https://app.example.com/settings/billing";
const ORG_DEFAULT = "https://acme.example.org/settings/billing";

const reqOnHost = (host: string) => ({ headers: { host } });

describe("Portal API - Service-Based Architecture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateAuthentication", () => {
    it("should return user when session exists", () => {
      const req = {
        session: {
          user: { id: 123 },
          hasValidLicense: true,
          upId: "test-upid",
          expires: "2024-12-31T23:59:59.999Z",
        } as Session,
      } as RequestWithSession;

      const result = validateAuthentication(req as NextApiRequest);

      expect(result).toEqual({ id: 123 });
    });

    it("should return null when session is missing", () => {
      const req = {} as NextApiRequest;

      const result = validateAuthentication(req);

      expect(result).toBeNull();
    });

    it("should return null when user id is missing", () => {
      const req = {
        session: {
          user: {} as any,
          hasValidLicense: true,
          upId: "test-upid",
          expires: "2024-12-31T23:59:59.999Z",
        } as Session,
      } as RequestWithSession;

      const result = validateAuthentication(req as NextApiRequest);

      expect(result).toBeNull();
    });
  });

  describe("buildReturnUrl", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    describe("with organizations disabled", () => {
      beforeEach(() => {
        vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
      });

      it("should return the app default URL when returnTo is not provided", () => {
        expect(buildReturnUrl(reqOnHost("app.example.com"))).toBe(APP_DEFAULT);
      });

      it("should ignore an organization host", () => {
        expect(buildReturnUrl(reqOnHost("acme.example.org"))).toBe(APP_DEFAULT);
      });

      it("should return the default URL when returnTo is not a string", () => {
        expect(buildReturnUrl(reqOnHost("app.example.com"), 123 as unknown as string)).toBe(APP_DEFAULT);
      });

      it("should return the default URL when returnTo is empty", () => {
        expect(buildReturnUrl(reqOnHost("app.example.com"), "")).toBe(APP_DEFAULT);
      });

      it("should return the default URL when returnTo is relative", () => {
        expect(buildReturnUrl(reqOnHost("app.example.com"), "/settings/teams")).toBe(APP_DEFAULT);
      });

      it("should keep a returnTo on the app domain", () => {
        const returnTo = "https://app.example.com/settings/teams";
        expect(buildReturnUrl(reqOnHost("app.example.com"), returnTo)).toBe(returnTo);
      });

      it("should return the app root when returnTo is unsafe", () => {
        expect(buildReturnUrl(reqOnHost("app.example.com"), "http://malicious-site.com")).toBe(
          "https://app.example.com/"
        );
      });
    });

    describe("with organizations enabled", () => {
      beforeEach(() => {
        vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
      });

      it("should default to the organization domain", () => {
        expect(buildReturnUrl(reqOnHost("acme.example.org"))).toBe(ORG_DEFAULT);
      });

      it("should keep a returnTo on the organization domain", () => {
        const returnTo = "https://acme.example.org/settings/teams";
        expect(buildReturnUrl(reqOnHost("acme.example.org"), returnTo)).toBe(returnTo);
      });

      it("should keep a returnTo on the app domain", () => {
        const returnTo = "https://app.example.com/settings/teams";
        expect(buildReturnUrl(reqOnHost("acme.example.org"), returnTo)).toBe(returnTo);
      });

      it("should return the organization root when returnTo is unsafe", () => {
        expect(buildReturnUrl(reqOnHost("acme.example.org"), "http://malicious-site.com")).toBe(
          "https://acme.example.org/"
        );
      });

      it("should use the app default on a host that is not in ALLOWED_HOSTNAMES", () => {
        expect(buildReturnUrl(reqOnHost("other.example.net"))).toBe(APP_DEFAULT);
      });
    });
  });

  describe("handler", () => {
    const buildRes = () => {
      const res = { status: vi.fn(), json: vi.fn() };
      res.status.mockReturnValue(res);
      return res;
    };

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it("should return 405 for unsupported methods", async () => {
      const res = buildRes();
      await handler({ method: "DELETE" } as NextApiRequest, res as unknown as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(405);
    });

    it("should return 401 when not authenticated", async () => {
      const res = buildRes();
      await handler(
        { method: "GET", headers: {}, query: {} } as unknown as NextApiRequest,
        res as unknown as NextApiResponse
      );

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should pass the organization billing URL to the billing portal", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
      const processBillingPortal = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(BillingPortalServiceFactory, "createUserService").mockReturnValue({
        processBillingPortal,
      } as unknown as UserBillingPortalService);
      const res = buildRes();

      await handler(
        {
          method: "GET",
          headers: { host: "acme.example.org" },
          query: {},
          session: { user: { id: 123 } },
        } as unknown as NextApiRequest,
        res as unknown as NextApiResponse
      );

      expect(processBillingPortal).toHaveBeenCalledWith(123, ORG_DEFAULT, res);
    });
  });

  describe("BillingPortalServiceFactory", () => {
    it("should create UserBillingPortalService", () => {
      const service = BillingPortalServiceFactory.createUserService();

      expect(service).toBeInstanceOf(UserBillingPortalService);
    });
  });

  describe("TeamBillingPortalService", () => {
    it("should return false for checkPermissions (EE feature removed)", async () => {
      const service = new TeamBillingPortalService();
      const result = await service.checkPermissions(123, 456);

      expect(result).toBe(false);
    });
  });

  describe("UserBillingPortalService", () => {
    let service: UserBillingPortalService;

    beforeEach(() => {
      service = new UserBillingPortalService();
      mockCustomerModule.getStripeCustomerIdFromUserId = vi.fn();
    });

    it("should get customer ID for user", async () => {
      mockCustomerModule.getStripeCustomerIdFromUserId.mockResolvedValue("cus_123");

      const result = await service.getCustomerId(123);

      expect(result).toBe("cus_123");
      expect(mockCustomerModule.getStripeCustomerIdFromUserId).toHaveBeenCalledWith(123);
    });
  });
});
