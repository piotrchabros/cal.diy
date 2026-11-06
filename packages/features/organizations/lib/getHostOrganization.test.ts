import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHostOrganization } from "./getHostOrganization";

const { mockGetOrgFromRequest } = vi.hoisted(() => ({
  mockGetOrgFromRequest: vi.fn(),
}));

vi.mock("./getOrgFromRequest", () => ({
  getOrgFromRequest: mockGetOrgFromRequest,
}));

const ORG = { id: 7, slug: "bespokesoft", domain: "cal.bespokesoft.pl", isDefault: false };

describe("getHostOrganization", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockGetOrgFromRequest.mockResolvedValue(ORG);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns disabled without any lookup when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getHostOrganization(new Headers({ host: "cal.bespokesoft.pl" }))).resolves.toEqual({
      status: "disabled",
    });
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
  });

  it("passes a Headers instance through and returns the resolved organization", async () => {
    const headers = new Headers({ host: "cal.bespokesoft.pl" });

    await expect(getHostOrganization(headers)).resolves.toEqual({ status: "resolved", org: ORG });
    expect(mockGetOrgFromRequest).toHaveBeenCalledWith(headers);
  });

  it("adapts a plain header object for the lookup", async () => {
    await expect(
      getHostOrganization({ host: "a.b", "x-cal-org-id": "7", "x-multi": ["a", "b"] })
    ).resolves.toEqual({ status: "resolved", org: ORG });

    const adapter = mockGetOrgFromRequest.mock.calls[0][0];
    expect(adapter.get("Host")).toBe("a.b");
    expect(adapter.get("x-cal-org-id")).toBe("7");
    expect(adapter.get("X-Multi")).toBe("a, b");
    expect(adapter.get("x-missing")).toBeNull();
  });

  it("returns unresolved when the host has no organization", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    await expect(getHostOrganization(new Headers())).resolves.toEqual({ status: "unresolved" });
  });

  it("returns unresolved when the organization has no slug", async () => {
    mockGetOrgFromRequest.mockResolvedValue({ ...ORG, slug: null });

    await expect(getHostOrganization(new Headers())).resolves.toEqual({ status: "unresolved" });
  });

  it("propagates lookup errors", async () => {
    mockGetOrgFromRequest.mockRejectedValue(new Error("db down"));

    await expect(getHostOrganization(new Headers())).rejects.toThrow("db down");
  });
});
