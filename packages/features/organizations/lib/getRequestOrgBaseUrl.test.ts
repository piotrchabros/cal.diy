import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRequestOrgBaseUrl } from "./getRequestOrgBaseUrl";

const { mockGetOrgFromRequest, mockGetBaseUrl } = vi.hoisted(() => ({
  mockGetOrgFromRequest: vi.fn(),
  mockGetBaseUrl: vi.fn(),
}));

vi.mock("./getOrgFromRequest", () => ({
  getOrgFromRequest: mockGetOrgFromRequest,
}));

vi.mock("../di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mockGetBaseUrl }),
}));

const headers = new Headers({ host: "cal.bespokesoft.pl" });
const DEFAULT_VALUE = { baseUrl: WEBAPP_URL, orgSlug: null };

describe("getRequestOrgBaseUrl", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockGetOrgFromRequest.mockResolvedValue({
      id: 7,
      slug: "bespokesoft",
      domain: "cal.bespokesoft.pl",
      isDefault: false,
    });
    mockGetBaseUrl.mockResolvedValue("https://cal.bespokesoft.pl");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns the default without any lookup when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getRequestOrgBaseUrl(headers)).resolves.toEqual(DEFAULT_VALUE);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockGetBaseUrl).not.toHaveBeenCalled();
  });

  it("returns the organization's base URL and slug", async () => {
    await expect(getRequestOrgBaseUrl(headers)).resolves.toEqual({
      baseUrl: "https://cal.bespokesoft.pl",
      orgSlug: "bespokesoft",
    });
    expect(mockGetOrgFromRequest).toHaveBeenCalledWith(headers);
    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 7 });
  });

  it("returns the default when the request has no organization", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    await expect(getRequestOrgBaseUrl(headers)).resolves.toEqual(DEFAULT_VALUE);
    expect(mockGetBaseUrl).not.toHaveBeenCalled();
  });

  it("returns the default when resolving the organization throws", async () => {
    mockGetOrgFromRequest.mockRejectedValue(new Error("db down"));

    await expect(getRequestOrgBaseUrl(headers)).resolves.toEqual(DEFAULT_VALUE);
  });

  it("returns the default when resolving the base URL throws", async () => {
    mockGetBaseUrl.mockRejectedValue(new Error("db down"));

    await expect(getRequestOrgBaseUrl(headers)).resolves.toEqual(DEFAULT_VALUE);
  });
});
