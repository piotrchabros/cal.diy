import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKnownOrganizationDomain } from "./organizationDomain";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { team: { findFirst: vi.fn() } },
}));

vi.mock("@calcom/prisma", () => ({
  default: prismaMock,
  prisma: prismaMock,
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
