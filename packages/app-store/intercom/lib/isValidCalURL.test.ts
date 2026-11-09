import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidCalURL } from "./isValidCalURL";

const { isKnownOrganizationDomainMock } = vi.hoisted(() => ({
  isKnownOrganizationDomainMock: vi.fn(),
}));

vi.mock("@calcom/lib/constants", () => ({
  CAL_URL: "https://cal.com",
}));

vi.mock("./organizationDomain", () => ({
  isKnownOrganizationDomain: isKnownOrganizationDomainMock,
}));

describe("isValidCalURL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isKnownOrganizationDomainMock.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts cal.com links without consulting organization domains", async () => {
    await expect(isValidCalURL("https://cal.com/alice/30min")).resolves.toEqual({ isValid: true });
    expect(isKnownOrganizationDomainMock).not.toHaveBeenCalled();
  });

  it("accepts links on a known organization custom domain", async () => {
    isKnownOrganizationDomainMock.mockResolvedValue(true);

    await expect(isValidCalURL("https://cal.bespokesoft.pl/alice/30min")).resolves.toEqual({
      isValid: true,
    });
    expect(isKnownOrganizationDomainMock).toHaveBeenCalledWith("cal.bespokesoft.pl");
  });

  it("rejects links on an unknown domain", async () => {
    isKnownOrganizationDomainMock.mockResolvedValue(false);

    const result = await isValidCalURL("https://evil.example.com/alice/30min");

    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects organization custom domains while organizations are disabled", async () => {
    // Flag-off lookup resolves false, so the org URL is rejected without fetching it.
    isKnownOrganizationDomainMock.mockImplementation(async () => false);

    const result = await isValidCalURL("https://cal.bespokesoft.pl/alice/30min");

    expect(result.isValid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs without fetching", async () => {
    const result = await isValidCalURL("not-a-url");

    expect(result.isValid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects org-domain links that do not resolve", async () => {
    isKnownOrganizationDomainMock.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));

    const result = await isValidCalURL("https://cal.bespokesoft.pl/alice/30min");

    expect(result.isValid).toBe(false);
  });
});
