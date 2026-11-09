import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrganizationBaseUrl,
  getOrganizationDomainById,
  isKnownOrganizationDomain,
} from "./organizationDomain";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { team: { findFirst: vi.fn() } },
}));

vi.mock("@calcom/prisma", () => ({
  default: prismaMock,
  prisma: prismaMock,
}));

vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "https://app.example.com",
}));

describe("isKnownOrganizationDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false without querying while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(isKnownOrganizationDomain("cal.bespokesoft.pl")).resolves.toBe(false);
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("returns true for a registered organization custom domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({ id: 9 });

    await expect(isKnownOrganizationDomain("cal.bespokesoft.pl")).resolves.toBe(true);
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith({
      where: {
        isOrganization: true,
        parentId: null,
        organizationSettings: { customDomain: "cal.bespokesoft.pl" },
      },
      select: { id: true },
    });
  });

  it("returns false for an unknown domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue(null);

    await expect(isKnownOrganizationDomain("evil.example.com")).resolves.toBe(false);
  });

  it("lowercases the hostname before lookup", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({ id: 9 });

    await expect(isKnownOrganizationDomain("CAL.BespokeSoft.PL")).resolves.toBe(true);
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationSettings: { customDomain: "cal.bespokesoft.pl" },
        }),
      })
    );
  });
});

describe("getOrganizationDomainById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null without querying while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getOrganizationDomainById(10)).resolves.toBeNull();
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("returns null without querying for a null organization id", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await expect(getOrganizationDomainById(null)).resolves.toBeNull();
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("returns the custom domain with the findDomainById predicate", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({
      organizationSettings: { customDomain: "acme.example.org" },
    });

    await expect(getOrganizationDomainById(10)).resolves.toBe("acme.example.org");
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith({
      where: { id: 10, isOrganization: true, parentId: null },
      select: { organizationSettings: { select: { customDomain: true } } },
    });
  });

  it("returns null for an unknown organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue(null);

    await expect(getOrganizationDomainById(10)).resolves.toBeNull();
  });

  it("returns null when the organization has no settings domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({ organizationSettings: null });

    await expect(getOrganizationDomainById(10)).resolves.toBeNull();
  });
});

describe("getOrganizationBaseUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns WEBAPP_URL without querying while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getOrganizationBaseUrl(10)).resolves.toBe("https://app.example.com");
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("returns WEBAPP_URL without querying for a null organization id", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await expect(getOrganizationBaseUrl(null)).resolves.toBe("https://app.example.com");
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("returns the organization origin for a custom domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({
      organizationSettings: { customDomain: "acme.example.org" },
    });

    await expect(getOrganizationBaseUrl(10)).resolves.toBe("https://acme.example.org");
  });

  it("falls back to WEBAPP_URL for an unknown organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue(null);

    await expect(getOrganizationBaseUrl(10)).resolves.toBe("https://app.example.com");
  });

  it("falls back to WEBAPP_URL when the domain is the default domain", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.team.findFirst.mockResolvedValue({
      organizationSettings: { customDomain: "app.example.com" },
    });

    await expect(getOrganizationBaseUrl(10)).resolves.toBe("https://app.example.com");
  });
});
