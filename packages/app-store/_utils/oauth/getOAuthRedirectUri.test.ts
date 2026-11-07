import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org", "cal.local:3000"] as string[],
}));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock("@calcom/lib/constants", () => constants);

vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: () => ({
      warn: (...args: unknown[]) => mockWarn(...args),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import {
  getOAuthAllowedOrigins,
  getOAuthAppOrigin,
  getOAuthRedirectUri,
  getOAuthSafeRedirectOptions,
} from "./getOAuthRedirectUri";

const DEFAULT_URI = "https://app.example.com/api/integrations/googlecalendar/callback";
const ACME_URI = "https://acme.example.org/api/integrations/googlecalendar/callback";

function reqWithHost(host?: string | string[]) {
  return { headers: host === undefined ? {} : { host } };
}

describe("getOAuthRedirectUri", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("uses the default callback when organizations are disabled, even for a trusted host", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    const req = reqWithHost("acme.example.org");

    expect(getOAuthRedirectUri(req, "googlecalendar")).toBe(DEFAULT_URI);
    expect(getOAuthAllowedOrigins(req)).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    "acme.example.org",
    "ACME.Example.org:443",
    "acme.example.org.",
  ])("uses the organization callback for trusted host %s", (host) => {
    expect(getOAuthRedirectUri(reqWithHost(host), "googlecalendar")).toBe(ACME_URI);
    expect(getOAuthAllowedOrigins(reqWithHost(host))).toEqual(["https://acme.example.org"]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("matches an allowed host entry that carries a port", () => {
    expect(getOAuthRedirectUri(reqWithHost("cal.local"), "googlecalendar")).toBe(
      "https://cal.local/api/integrations/googlecalendar/callback"
    );
  });

  it("falls back and warns for a host that is not allowed", () => {
    expect(getOAuthRedirectUri(reqWithHost("evil.com"), "googlecalendar")).toBe(DEFAULT_URI);
    expect(getOAuthAllowedOrigins(reqWithHost("evil.com"))).toEqual([]);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), {
      host: "evil.com",
      appSlug: "googlecalendar",
    });
  });

  it.each([
    "localhost:3000",
    "127.0.0.1",
    "[::1]",
  ])("falls back without warning for loopback host %s", (host) => {
    expect(getOAuthRedirectUri(reqWithHost(host), "googlecalendar")).toBe(DEFAULT_URI);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("falls back without warning for the default app host, even when it is in the allowed list", () => {
    constants.ALLOWED_HOSTNAMES.push("app.example.com");
    try {
      const req = reqWithHost("app.example.com");
      expect(getOAuthRedirectUri(req, "googlecalendar")).toBe(DEFAULT_URI);
      expect(getOAuthAllowedOrigins(req)).toEqual([]);
      expect(mockWarn).not.toHaveBeenCalled();
    } finally {
      constants.ALLOWED_HOSTNAMES.pop();
    }
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["array", ["acme.example.org"]],
  ])("falls back without warning when the host header is %s", (_label, host) => {
    expect(getOAuthRedirectUri(reqWithHost(host), "googlecalendar")).toBe(DEFAULT_URI);
    expect(getOAuthAllowedOrigins(reqWithHost(host))).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("uses an explicit allowed hosts list instead of ALLOWED_HOSTNAMES", () => {
    expect(getOAuthRedirectUri(reqWithHost("other.org"), "googlecalendar", ["other.org"])).toBe(
      "https://other.org/api/integrations/googlecalendar/callback"
    );
    expect(getOAuthRedirectUri(reqWithHost("acme.example.org"), "googlecalendar", ["other.org"])).toBe(
      DEFAULT_URI
    );
    expect(getOAuthAllowedOrigins(reqWithHost("acme.example.org"), ["other.org"])).toEqual([]);
  });

  it("falls back to WEBAPP_URL_FOR_OAUTH when it differs from WEBAPP_URL", () => {
    const original = constants.WEBAPP_URL_FOR_OAUTH;
    constants.WEBAPP_URL_FOR_OAUTH = "http://localhost:3000";
    try {
      expect(getOAuthRedirectUri(reqWithHost("evil.com"), "googlecalendar")).toBe(
        "http://localhost:3000/api/integrations/googlecalendar/callback"
      );
      expect(getOAuthRedirectUri(reqWithHost("acme.example.org"), "googlecalendar")).toBe(ACME_URI);
    } finally {
      constants.WEBAPP_URL_FOR_OAUTH = original;
    }
  });

  it("refuses the host of WEBAPP_URL_FOR_OAUTH when it differs from WEBAPP_URL", () => {
    const original = constants.WEBAPP_URL_FOR_OAUTH;
    constants.WEBAPP_URL_FOR_OAUTH = "https://oauth.example.com";
    try {
      expect(getOAuthAllowedOrigins(reqWithHost("oauth.example.com"), ["oauth.example.com"])).toEqual([]);
    } finally {
      constants.WEBAPP_URL_FOR_OAUTH = original;
    }
  });
});

describe("getOAuthAppOrigin", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns the organization origin for a trusted host", () => {
    expect(getOAuthAppOrigin(reqWithHost("acme.example.org"))).toBe("https://acme.example.org");
  });

  it("returns WEBAPP_URL for an untrusted host", () => {
    expect(getOAuthAppOrigin(reqWithHost("evil.com"))).toBe("https://app.example.com");
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe("getOAuthSafeRedirectOptions", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("allows the organization origin and falls back to it for a trusted host", () => {
    expect(getOAuthSafeRedirectOptions(reqWithHost("acme.example.org"))).toEqual({
      allowedOrigins: ["https://acme.example.org"],
      fallbackUrl: "https://acme.example.org/",
    });
  });

  it("allows nothing extra and falls back to WEBAPP_URL for an untrusted host", () => {
    expect(getOAuthSafeRedirectOptions(reqWithHost("evil.com"))).toEqual({
      allowedOrigins: [],
      fallbackUrl: "https://app.example.com/",
    });
  });
});

describe("organization origins on a local multi-domain setup", () => {
  const original = {
    WEBAPP_URL: constants.WEBAPP_URL,
    WEBAPP_URL_FOR_OAUTH: constants.WEBAPP_URL_FOR_OAUTH,
    ALLOWED_HOSTNAMES: constants.ALLOWED_HOSTNAMES,
  };
  const req = reqWithHost("bespoke.test:3747");

  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    constants.WEBAPP_URL = "http://bluebee.test:3747";
    constants.WEBAPP_URL_FOR_OAUTH = "http://bluebee.test:3747";
    constants.ALLOWED_HOSTNAMES = ["bluebee.test", "bespoke.test"];
  });

  afterEach(() => {
    Object.assign(constants, original);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps the webapp's http scheme and dev port", () => {
    expect(getOAuthRedirectUri(req, "googlecalendar")).toBe(
      "http://bespoke.test:3747/api/integrations/googlecalendar/callback"
    );
    expect(getOAuthAllowedOrigins(req)).toEqual(["http://bespoke.test:3747"]);
    expect(getOAuthAppOrigin(req)).toBe("http://bespoke.test:3747");
    expect(getOAuthSafeRedirectOptions(req)).toEqual({
      allowedOrigins: ["http://bespoke.test:3747"],
      fallbackUrl: "http://bespoke.test:3747/",
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("uses the default callback when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(getOAuthRedirectUri(req, "googlecalendar")).toBe(
      "http://bluebee.test:3747/api/integrations/googlecalendar/callback"
    );
    expect(getOAuthAllowedOrigins(req)).toEqual([]);
    expect(getOAuthAppOrigin(req)).toBe("http://bluebee.test:3747");
    expect(getOAuthSafeRedirectOptions(req)).toEqual({
      allowedOrigins: [],
      fallbackUrl: "http://bluebee.test:3747/",
    });
  });
});
