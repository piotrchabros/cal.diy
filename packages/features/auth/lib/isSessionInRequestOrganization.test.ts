import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSessionInRequestOrganization } from "./isSessionInRequestOrganization";

const { mockGetOrgFromRequest, mockIsUserInOrganization, mockWarn } = vi.hoisted(() => ({
  mockGetOrgFromRequest: vi.fn(),
  mockIsUserInOrganization: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: mockGetOrgFromRequest,
}));

vi.mock("@calcom/features/organizations/di/OrganizationSignInService.container", () => ({
  getOrganizationSignInService: () => ({ isUserInOrganization: mockIsUserInOrganization }),
}));

vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

const ORG = { id: 7, slug: "bespokesoft", domain: "cal.bespokesoft.pl", isDefault: false };

describe("isSessionInRequestOrganization", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockGetOrgFromRequest.mockResolvedValue(ORG);
    mockIsUserInOrganization.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns true without any lookup when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(
      isSessionInRequestOrganization({ userId: 1, headers: { host: "cal.bespokesoft.pl" } })
    ).resolves.toBe(true);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockIsUserInOrganization).not.toHaveBeenCalled();
  });

  it("adapts a plain header object for the organization lookup", async () => {
    await isSessionInRequestOrganization({ userId: 1, headers: { host: "cal.bespokesoft.pl" } });

    const getter = mockGetOrgFromRequest.mock.calls[0][0];
    expect(getter.get("Host")).toBe("cal.bespokesoft.pl");
  });

  it("accepts a Headers instance", async () => {
    const headers = new Headers({ host: "cal.bespokesoft.pl" });

    await expect(isSessionInRequestOrganization({ userId: 1, headers })).resolves.toBe(true);
    expect(mockGetOrgFromRequest.mock.calls[0][0].get("host")).toBe("cal.bespokesoft.pl");
  });

  it("returns true when the user belongs to the request organization", async () => {
    await expect(isSessionInRequestOrganization({ userId: 1, headers: new Headers() })).resolves.toBe(true);
    expect(mockIsUserInOrganization).toHaveBeenCalledWith({ userId: 1, organizationId: 7 });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns false and warns when the user does not belong to the request organization", async () => {
    mockIsUserInOrganization.mockResolvedValue(false);

    await expect(isSessionInRequestOrganization({ userId: 1, headers: new Headers() })).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), { userId: 1, requestOrganizationId: 7 });
  });

  it("checks against no organization when the host does not resolve to one", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    await isSessionInRequestOrganization({ userId: 1, headers: new Headers() });
    expect(mockIsUserInOrganization).toHaveBeenCalledWith({ userId: 1, organizationId: null });
  });

  it("propagates lookup errors", async () => {
    mockGetOrgFromRequest.mockRejectedValue(new Error("db down"));

    await expect(isSessionInRequestOrganization({ userId: 1, headers: new Headers() })).rejects.toThrow(
      "db down"
    );
  });
});
