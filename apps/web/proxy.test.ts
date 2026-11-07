// Import mocked functions

import { createRequire } from "node:module";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { get as edgeConfigGet } from "@vercel/edge-config";
import { NextRequest, NextResponse } from "next/server";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// We'll test the wrapped proxy as it would be used in production
import proxy, { config } from "./proxy";

// Next's bundled copy ships without type declarations; it is the matcher compiler Next itself uses.
const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (source: string) => RegExp;
};

// Mock dependencies at module level
vi.mock("@vercel/edge-config", () => ({
  get: vi.fn(),
}));

const { resolveOrg, getOrganizationDomainResolver } = vi.hoisted(() => {
  const resolveOrg = vi.fn();
  return { resolveOrg, getOrganizationDomainResolver: vi.fn(() => ({ resolve: resolveOrg })) };
});

vi.mock("@calcom/features/organizations/di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver,
}));

const { handleOrgRedirect } = vi.hoisted(() => ({ handleOrgRedirect: vi.fn() }));

vi.mock("@lib/handleOrgRedirect", () => ({ handleOrgRedirect }));

// Mock NextResponse.json since it's not available in test environment
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");

  // Create a NextResponse constructor that returns Response objects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NextResponse = function (body: any, init?: ResponseInit) {
    return new Response(body, init);
  };

  // Add static methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NextResponse.json = (body: any, init?: ResponseInit) => {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: {
        ...init?.headers,
        "content-type": "application/json",
      },
    });
  };

  NextResponse.next = (init?: ResponseInit) => {
    const response = new Response(null, {
      status: 200,
      ...init,
      headers: {
        ...init?.headers,
        "x-middleware-next": "1",
      },
    });

    // Add cookies property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (response as any).cookies = {
      delete: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
    };

    return response;
  };

  NextResponse.rewrite = (url: URL | string, init?: ResponseInit) => {
    const rewriteUrl = typeof url === "string" ? new URL(url) : url;
    return new Response(null, {
      status: 200,
      ...init,
      headers: {
        ...init?.headers,
        "x-middleware-rewrite": rewriteUrl.toString(),
      },
    });
  };

  NextResponse.redirect = (url: URL | string, statusOrInit?: number | ResponseInit) => {
    const redirectUrl = typeof url === "string" ? new URL(url) : url;
    const status = typeof statusOrInit === "number" ? statusOrInit : statusOrInit?.status || 307;
    const init = typeof statusOrInit === "object" ? statusOrInit : {};

    const response = new Response(null, {
      ...init,
      status,
      headers: {
        ...init.headers,
        location: redirectUrl.toString(),
      },
    });

    // Add cookies property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (response as any).cookies = {
      delete: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
    };

    return response;
  };

  return {
    ...actual,
    NextResponse,
  };
});

const createTestRequest = (overrides?: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}) => {
  const url = overrides?.url || `${WEBAPP_URL}/test-path`;
  const method = overrides?.method || "GET";
  const headers = new Headers(overrides?.headers || {});

  const req = new NextRequest(new Request(url, { method, headers }));

  // Add cookies if provided
  if (overrides?.cookies) {
    Object.entries(overrides.cookies).forEach(([name, value]) => {
      req.cookies.set(name, value);
    });
  }

  return req;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createEdgeConfigMock = (config: Record<string, any>) => {
  return (key: string) => {
    if (key in config) return Promise.resolve(config[key]);
    return Promise.resolve(undefined);
  };
};

// Helper to safely get header value
const getHeader = (res: Response, name: string) => {
  return res.headers.get(name);
};

// Helper to check response status
const expectStatus = (res: Response, status: number) => {
  expect(res.status).toBe(status);
};

// Wrapper for proxy calls to handle type casting
const callProxy = async (req: NextRequest): Promise<Response> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (proxy as any)(req)) as Response;
};

describe("Middleware Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set test environment
    vi.stubEnv("NEXT_PUBLIC_WEBAPP_URL", WEBAPP_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Static File Handling", () => {
    it("should skip processing for static files", async () => {
      const staticPaths = ["/images/logo.png", "/_next/static/main.js", "/favicon.ico"];

      for (const path of staticPaths) {
        const req = createTestRequest({ url: `${WEBAPP_URL}${path}` });
        const res = await callProxy(req);

        expect(res).toBeDefined();
        expectStatus(res, 200);
        expect(getHeader(res, "x-middleware-next")).toBe("1");
      }
    });
  });

  describe("Maintenance Mode", () => {
    it("should redirect to maintenance when enabled", async () => {
      (edgeConfigGet as Mock).mockImplementation(
        createEdgeConfigMock({
          isInMaintenanceMode: true,
        })
      );

      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test`,
      });

      const res = await callProxy(req);
      expect(res).toBeDefined();
      expectStatus(res, 200);
    });

    it("should not affect API routes in maintenance mode", async () => {
      (edgeConfigGet as Mock).mockImplementation(
        createEdgeConfigMock({
          isInMaintenanceMode: true,
        })
      );

      const req = createTestRequest({
        url: `${WEBAPP_URL}/api/bookings`,
      });

      const res = await callProxy(req);
      expect(res).toBeDefined();
      expectStatus(res, 200);
    });
  });

  describe("Signup Control", () => {
    it("should block signup when disabled", async () => {
      (edgeConfigGet as Mock).mockImplementation(
        createEdgeConfigMock({
          isSignupDisabled: true,
        })
      );

      const req = createTestRequest({
        url: `${WEBAPP_URL}/api/auth/signup`,
        method: "POST",
      });

      const res = await callProxy(req);
      expectStatus(res, 503);

      const body = await res.text();
      expect(body).toContain("Signup is disabled");
    });

    it("should allow signup when enabled", async () => {
      (edgeConfigGet as Mock).mockImplementation(
        createEdgeConfigMock({
          isSignupDisabled: false,
        })
      );

      const req = createTestRequest({
        url: `${WEBAPP_URL}/api/auth/signup`,
        method: "POST",
      });

      const res = await callProxy(req);
      expectStatus(res, 200);
    });
  });

  describe("Cookie Management", () => {
    it("should handle return-to cookie redirect", async () => {
      const returnUrl = "/dashboard";
      const req = createTestRequest({
        url: `${WEBAPP_URL}/apps/installed`,
        cookies: { "return-to": returnUrl },
      });

      const res = await callProxy(req);
      expectStatus(res, 307);
      expect(getHeader(res, "location")).toContain(returnUrl);
    });

    it("should not redirect without return-to cookie", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/apps/installed`,
      });

      const res = await callProxy(req);
      expectStatus(res, 200);
    });

    it("should delete session cookie on logout", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/auth/logout`,
      });

      const res = await callProxy(req);
      const setCookie = getHeader(res, "set-cookie");

      if (setCookie) {
        expect(setCookie).toContain("next-auth.session-token");
      }
    });
  });

  describe("Embed Routes", () => {
    it("should add embed headers", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test/embed`,
      });

      const res = await callProxy(req);
      expect(getHeader(res, "x-isEmbed")).toBe("true");
    });

    it("should add COEP header when requested", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test/embed?flag.coep=true`,
      });

      const res = await callProxy(req);
      expect(getHeader(res, "Cross-Origin-Embedder-Policy")).toBe("require-corp");
    });

    it("should add color scheme header", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test/embed?ui.color-scheme=dark`,
      });

      const res = await callProxy(req);
      expect(getHeader(res, "x-embedColorScheme")).toBe("dark");
    });
  });

  describe("CSP Headers", () => {
    beforeEach(() => {
      vi.stubEnv("CSP_POLICY", "strict");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("should add CSP headers to login pages", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/auth/login`,
      });

      const res = await callProxy(req);
      const cspHeader = getHeader(res, "content-security-policy");

      expect(cspHeader).toBeTruthy();
      expect(cspHeader).toContain("default-src");
      expect(cspHeader).toContain("script-src");
    });

    it("should not add CSP headers to non-login pages", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test`,
      });

      const res = await callProxy(req);
      const cspHeader = getHeader(res, "content-security-policy");

      expect(cspHeader).toBeNull();
    });

    it("should add x-csp-status when CSP_POLICY not set", async () => {
      vi.unstubAllEnvs();

      const req = createTestRequest({
        url: `${WEBAPP_URL}/auth/login`,
      });

      const res = await callProxy(req);
      expect(getHeader(res, "x-csp-status")).toBe("not-opted-in");
    });
  });

  describe("Header sanitization", () => {
    it("sanitizes non-ASCII request header values to prevent Vercel Runtime Malformed Response Header", async () => {
      const spy = vi.spyOn(NextResponse, "next");

      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test`,
        // Next.js will translate request overrides into x-middleware-request-* headers internally
        headers: {
          "cf-region": "São Paulo", // contains non-ASCII "ã"
        },
      });

      const res = await callProxy(req);
      expectStatus(res, 200);

      // Assert that middleware forwarded sanitized ASCII-only value
      const initArg = (spy as unknown as Mock).mock.calls.at(-1)?.[0] as {
        request?: { headers?: Headers };
      };
      expect(initArg?.request?.headers).toBeDefined();

      const forwarded = initArg?.request?.headers as Headers;
      expect(forwarded.get("cf-region")).toBe("Sao Paulo");

      spy.mockRestore();
    });

    it("strips non-ASCII bytes in mojibake values (e.g., 'SÃ£o Paulo' -> 'So Paulo')", async () => {
      const spy = vi.spyOn(NextResponse, "next");

      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test`,
        headers: {
          "cf-region": "SÃ£o Paulo", // mojibake for "São Paulo"; includes non-ASCII bytes
        },
      });

      const res = await callProxy(req);
      expectStatus(res, 200);

      const initArg = (spy as unknown as Mock).mock.calls.at(-1)?.[0] as {
        request?: { headers?: Headers };
      };
      const forwarded = initArg?.request?.headers as Headers;
      expect(forwarded.get("cf-region")).toBe("So Paulo");

      spy.mockRestore();
    });
  });

  describe("Multiple Features", () => {
    it("should handle embed route with query params", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test/embed?ui.color-scheme=light`,
      });

      const res = await callProxy(req);
      expect(getHeader(res, "x-isEmbed")).toBe("true");
      expect(getHeader(res, "x-embedColorScheme")).toBe("light");
    });
  });

  describe("Error Handling", () => {
    it("should handle Edge Config errors gracefully", async () => {
      (edgeConfigGet as Mock).mockImplementation(() => {
        throw new Error("Config error");
      });

      const req = createTestRequest({
        url: `${WEBAPP_URL}/team/test`,
      });

      const res = await callProxy(req);
      expect(res).toBeDefined();
      expectStatus(res, 200);
    });

    it("should handle malformed URLs", async () => {
      const req = createTestRequest({
        url: `${WEBAPP_URL}//double-slash`,
      });

      const res = await callProxy(req);
      expect(res).toBeDefined();
    });
  });
});

describe("Middleware Matcher Configuration", () => {
  const matchers = config.matcher.map((source) => pathToRegexp(source));
  const matches = (path: string) => matchers.some((regexp) => regexp.test(path));

  it.each([
    "/",
    "/team/a",
    "/api/version",
    "/api/trpc/x",
    "/_next/data/b/x.json",
    "/u/avatar.png",
    "/x/embed",
  ])("runs on %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each(["/_next/static/c.js", "/_next/image", "/favicon.ico"])("skips %s", (path) => {
    expect(matches(path)).toBe(false);
  });
});

const ORG_HEADERS = ["x-cal-org-id", "x-cal-org-slug", "x-cal-org-domain", "x-cal-org-default"];
const SPOOFED_ORG_HEADERS = {
  "x-cal-org-id": "999",
  "x-cal-org-slug": "evil",
  "x-cal-org-domain": "evil.example",
  "x-cal-org-default": "1",
};

const forwardedHeaders = (spy: ReturnType<typeof vi.spyOn>): Headers => {
  const initArg = (spy as unknown as Mock).mock.calls.at(-1)?.[0] as { request?: { headers?: Headers } };
  return initArg?.request?.headers as Headers;
};

describe("Request organization resolution", () => {
  let nextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    nextSpy = vi.spyOn(NextResponse, "next");
  });

  afterEach(() => {
    nextSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it.each(["/team/x", "/auth/login"])("strips spoofed org headers on %s", async (path) => {
      const res = await callProxy(
        createTestRequest({ url: `${WEBAPP_URL}${path}`, headers: SPOOFED_ORG_HEADERS })
      );

      expectStatus(res, 200);
      const forwarded = forwardedHeaders(nextSpy);
      for (const header of ORG_HEADERS) expect(forwarded.get(header)).toBeNull();
      expect(getOrganizationDomainResolver).not.toHaveBeenCalled();
      expect(resolveOrg).not.toHaveBeenCalled();
    });

    it("strips spoofed org headers from the return-to redirect", async () => {
      const res = await callProxy(
        createTestRequest({
          url: `${WEBAPP_URL}/apps/installed`,
          headers: SPOOFED_ORG_HEADERS,
          cookies: { "return-to": "/dashboard" },
        })
      );

      expectStatus(res, 307);
      for (const header of ORG_HEADERS) expect(getHeader(res, header)).toBeNull();
    });
  });

  describe("with organizations enabled", () => {
    const org = { id: 7, slug: "acme", domain: "cal.acme.test", isDefault: false };

    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it.each(["/team/x", "/auth/login"])("forwards the resolved org headers on %s", async (path) => {
      resolveOrg.mockResolvedValue(org);

      const res = await callProxy(
        createTestRequest({
          url: `https://cal.acme.test${path}`,
          headers: { host: "cal.acme.test", ...SPOOFED_ORG_HEADERS },
        })
      );

      expectStatus(res, 200);
      expect(resolveOrg).toHaveBeenCalledWith("cal.acme.test");
      const forwarded = forwardedHeaders(nextSpy);
      expect(forwarded.get("x-cal-org-id")).toBe("7");
      expect(forwarded.get("x-cal-org-slug")).toBe("acme");
      expect(forwarded.get("x-cal-org-domain")).toBe("cal.acme.test");
      expect(forwarded.get("x-cal-org-default")).toBe("0");
    });

    it("returns a plain 404 for an unknown host", async () => {
      resolveOrg.mockResolvedValue(null);

      const res = await callProxy(
        createTestRequest({ url: "https://unknown.test/team/x", headers: { host: "unknown.test" } })
      );

      expectStatus(res, 404);
      expect(getHeader(res, "content-type")).toBe("text/plain");
      expect(getHeader(res, "location")).toBeNull();
      expect(await res.text()).toBe("Not Found");
      expect(nextSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["loopback", "localhost:3000"],
      ["WEBAPP_URL", new URL(WEBAPP_URL).host],
    ])("passes the %s host through without org headers when nothing matches", async (_label, host) => {
      resolveOrg.mockResolvedValue(null);

      const res = await callProxy(
        createTestRequest({ url: `http://${host}/team/x`, headers: { host, ...SPOOFED_ORG_HEADERS } })
      );

      expectStatus(res, 200);
      const forwarded = forwardedHeaders(nextSpy);
      for (const header of ORG_HEADERS) expect(forwarded.get(header)).toBeNull();
    });

    it("returns a plain 503 when the lookup fails for an unknown host", async () => {
      resolveOrg.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const res = await callProxy(
        createTestRequest({ url: "https://unknown.test/team/x", headers: { host: "unknown.test" } })
      );

      expectStatus(res, 503);
      expect(getHeader(res, "content-type")).toBe("text/plain");
      expect(await res.text()).toBe("Service Unavailable");
      consoleSpy.mockRestore();
    });

    it("passes a loopback host through when the lookup fails", async () => {
      resolveOrg.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const res = await callProxy(
        createTestRequest({ url: "http://localhost:3000/team/x", headers: { host: "localhost:3000" } })
      );

      expectStatus(res, 200);
      const forwarded = forwardedHeaders(nextSpy);
      for (const header of ORG_HEADERS) expect(forwarded.get(header)).toBeNull();
      consoleSpy.mockRestore();
    });
  });
});

describe("Legacy route gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CSP_POLICY", "strict");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["/team/x", "/api/trpc/x"])("skips CSP handling on %s", async (path) => {
    const nextSpy = vi.spyOn(NextResponse, "next");
    const res = await callProxy(createTestRequest({ url: `${WEBAPP_URL}${path}` }));

    expect(forwardedHeaders(nextSpy).get("x-csp-nonce")).toBeNull();
    nextSpy.mockRestore();
    expect(getHeader(res, "x-csp-nonce")).toBeNull();
    expect(getHeader(res, "x-csp-status")).toBeNull();
    expect(getHeader(res, "content-security-policy")).toBeNull();
  });

  it("keeps CSP handling on /auth/login", async () => {
    const nextSpy = vi.spyOn(NextResponse, "next");
    const res = await callProxy(createTestRequest({ url: `${WEBAPP_URL}/auth/login` }));

    expect(forwardedHeaders(nextSpy).get("x-csp-nonce")).toBeTruthy();
    nextSpy.mockRestore();
    expect(getHeader(res, "content-security-policy")).toBeTruthy();
  });

  it("does not fire the return-to redirect below /apps/installed", async () => {
    const res = await callProxy(
      createTestRequest({
        url: `${WEBAPP_URL}/apps/installed/calendar`,
        cookies: { "return-to": "/dashboard" },
      })
    );

    expectStatus(res, 200);
    expect(getHeader(res, "location")).toBeNull();
  });

  it("fires the return-to redirect on /apps/installed/", async () => {
    const res = await callProxy(
      createTestRequest({ url: `${WEBAPP_URL}/apps/installed/`, cookies: { "return-to": "/dashboard" } })
    );

    expectStatus(res, 307);
    expect(getHeader(res, "location")).toContain("/dashboard");
  });
});

describe("Moved team redirects", () => {
  const org = { id: 7, slug: "bluebee", domain: "bluebee.test", isDefault: false };
  const teamRequest = (path: string) =>
    createTestRequest({ url: `https://bluebee.test${path}`, headers: { host: "bluebee.test" } });
  const movedTo = (destination: string) => ({ redirect: { permanent: true, destination } });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrg.mockResolvedValue(org);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not look anything up with organizations disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const res = await callProxy(teamRequest("/team/sales"));

    expectStatus(res, 200);
    expect(getHeader(res, "location")).toBeNull();
    expect(resolveOrg).not.toHaveBeenCalled();
    expect(handleOrgRedirect).not.toHaveBeenCalled();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("answers a moved team link with a 308", async () => {
      handleOrgRedirect.mockResolvedValue(movedTo("https://bespoke.test/team/sales?member=1"));

      const res = await callProxy(teamRequest("/team/Sales?member=1"));

      expectStatus(res, 308);
      expect(getHeader(res, "location")).toBe("https://bespoke.test/team/sales?member=1");
      expect(handleOrgRedirect).toHaveBeenCalledWith({
        slugs: ["sales"],
        redirectType: "Team",
        eventTypeSlug: null,
        query: { member: "1" },
        hostOrgId: 7,
      });
    });

    it("answers a moved team event type link with a 308", async () => {
      handleOrgRedirect.mockResolvedValue(movedTo("https://bespoke.test/team/sales/30min"));

      const res = await callProxy(teamRequest("/team/sales/30min/"));

      expectStatus(res, 308);
      expect(getHeader(res, "location")).toBe("https://bespoke.test/team/sales/30min");
      expect(handleOrgRedirect).toHaveBeenCalledWith({
        slugs: ["sales"],
        redirectType: "TeamEventType",
        eventTypeSlug: "30min",
        query: {},
        hostOrgId: 7,
      });
    });

    it("passes through when the team has not moved", async () => {
      handleOrgRedirect.mockResolvedValue(null);

      const res = await callProxy(teamRequest("/team/sales"));

      expectStatus(res, 200);
      expect(getHeader(res, "location")).toBeNull();
      expect(handleOrgRedirect).toHaveBeenCalledTimes(1);
    });

    it("passes through when the lookup fails", async () => {
      handleOrgRedirect.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const res = await callProxy(teamRequest("/team/sales"));

      expectStatus(res, 200);
      consoleSpy.mockRestore();
    });

    it.each([
      "/team/sales/embed",
      "/team/sales/30min/embed",
      "/team/sales/30min/extra",
    ])("ignores %s", async (path) => {
      await callProxy(teamRequest(path));
      expect(handleOrgRedirect).not.toHaveBeenCalled();
    });

    it("ignores team links on a host without an organization", async () => {
      resolveOrg.mockResolvedValue(null);

      const res = await callProxy(
        createTestRequest({ url: "http://localhost:3000/team/sales", headers: { host: "localhost:3000" } })
      );

      expectStatus(res, 200);
      expect(handleOrgRedirect).not.toHaveBeenCalled();
    });

    // T430: the team pages 404 on a host without an organization before their own redirect lookup, so
    // non-org (fromOrgId 0) redirects are only served with organizations disabled; the proxy must not add them.
    it.each([
      ["/team/sales", "loopback", "localhost:3000"],
      ["/team/sales/30min", "loopback", "localhost:3000"],
      ["/team/sales", "WEBAPP_URL", new URL(WEBAPP_URL).host],
      ["/team/sales/30min", "WEBAPP_URL", new URL(WEBAPP_URL).host],
    ])("does not look up %s on the %s host without an organization", async (path, _label, host) => {
      resolveOrg.mockResolvedValue(null);
      handleOrgRedirect.mockResolvedValue(movedTo("https://bespoke.test/team/sales"));

      const res = await callProxy(createTestRequest({ url: `http://${host}${path}`, headers: { host } }));

      expectStatus(res, 200);
      expect(getHeader(res, "location")).toBeNull();
      expect(handleOrgRedirect).not.toHaveBeenCalled();
    });

    it("does not look up team links when the trusted-host org lookup fails", async () => {
      resolveOrg.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const res = await callProxy(
        createTestRequest({ url: "http://localhost:3000/team/sales", headers: { host: "localhost:3000" } })
      );

      expectStatus(res, 200);
      expect(handleOrgRedirect).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("does not look up team links on an organization without a slug", async () => {
      resolveOrg.mockResolvedValue({ ...org, slug: null });

      const res = await callProxy(teamRequest("/team/sales"));

      expectStatus(res, 200);
      expect(handleOrgRedirect).not.toHaveBeenCalled();
    });
  });
});
