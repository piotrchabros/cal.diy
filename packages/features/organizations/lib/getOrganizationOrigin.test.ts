import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrganizationOriginForUrl, getSafeRedirectUrlForOrganizations } from "./getOrganizationOrigin";

const { mockResolve, mockGetOrganizationDomainResolver } = vi.hoisted(() => {
  const mockResolve = vi.fn();
  return {
    mockResolve,
    mockGetOrganizationDomainResolver: vi.fn(() => ({ resolve: mockResolve })),
  };
});

vi.mock("../di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: mockGetOrganizationDomainResolver,
}));

const ACME = { id: 7, slug: "acme", domain: "cal.acme.com", isDefault: false };

describe("getOrganizationOriginForUrl", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockResolve.mockImplementation(async (host: string) => (host === "cal.acme.com" ? ACME : null));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns null without touching the resolver when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getOrganizationOriginForUrl("https://cal.acme.com/x")).resolves.toBeNull();
    expect(mockGetOrganizationDomainResolver).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns the origin for an organization's domain", async () => {
    await expect(getOrganizationOriginForUrl("https://cal.acme.com/team/x?y=1")).resolves.toBe(
      "https://cal.acme.com"
    );
    expect(mockResolve).toHaveBeenCalledWith("cal.acme.com");
  });

  it("returns null for an unknown host", async () => {
    await expect(getOrganizationOriginForUrl("https://evil.com/x")).resolves.toBeNull();
  });

  it("returns null when the resolved organization's domain differs from the host", async () => {
    mockResolve.mockResolvedValue({ ...ACME, domain: "other.acme.com" });
    await expect(getOrganizationOriginForUrl("https://cal.acme.com/x")).resolves.toBeNull();

    mockResolve.mockResolvedValue({ ...ACME, domain: null });
    await expect(getOrganizationOriginForUrl("https://cal.acme.com/x")).resolves.toBeNull();
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["not a url"],
    ["/relative/path"],
    ["https://localhost/x"],
    ["https://127.0.0.1/x"],
    ["https://[::1]/x"],
    ["http://cal.acme.com/x"],
    ["https://cal.acme.com:8443/x"],
    ["https://user@cal.acme.com/x"],
    ["https://user:pass@cal.acme.com/x"],
    ["https://user@evil.com"],
  ])("returns null for %s without a lookup", async (url) => {
    await expect(getOrganizationOriginForUrl(url)).resolves.toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns null when the resolver throws", async () => {
    mockResolve.mockRejectedValue(new Error("db down"));
    await expect(getOrganizationOriginForUrl("https://cal.acme.com/x")).resolves.toBeNull();
  });
});

describe("getSafeRedirectUrlForOrganizations", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockResolve.mockImplementation(async (host: string) => (host === "cal.acme.com" ? ACME : null));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("allows an organization's origin", async () => {
    await expect(getSafeRedirectUrlForOrganizations("https://cal.acme.com/team/x")).resolves.toBe(
      "https://cal.acme.com/team/x"
    );
  });

  it("keeps webapp URLs", async () => {
    await expect(getSafeRedirectUrlForOrganizations(`${WEBAPP_URL}/bookings`)).resolves.toBe(
      `${WEBAPP_URL}/bookings`
    );
  });

  it("falls back to the webapp root for other origins", async () => {
    await expect(getSafeRedirectUrlForOrganizations("https://evil.com/x")).resolves.toBe(`${WEBAPP_URL}/`);
    await expect(getSafeRedirectUrlForOrganizations("http://cal.acme.com/x")).resolves.toBe(`${WEBAPP_URL}/`);
  });

  it("falls back for an organization's origin when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    await expect(getSafeRedirectUrlForOrganizations("https://cal.acme.com/x")).resolves.toBe(
      `${WEBAPP_URL}/`
    );
  });

  it("returns null for an empty URL and throws for a relative one, like getSafeRedirectUrl", async () => {
    await expect(getSafeRedirectUrlForOrganizations()).resolves.toBeNull();
    await expect(getSafeRedirectUrlForOrganizations("/bookings")).rejects.toThrow("Pass an absolute URL");
  });
});
