import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBookingOrganizationBaseUrl } from "./getBookingOrganizationBaseUrl";

const { mockGetOrganizationUrlService, mockGetBaseUrlForTeam, mockGetBaseUrlForUser } = vi.hoisted(() => {
  const mockGetBaseUrlForTeam = vi.fn();
  const mockGetBaseUrlForUser = vi.fn();
  return {
    mockGetBaseUrlForTeam,
    mockGetBaseUrlForUser,
    mockGetOrganizationUrlService: vi.fn(() => ({
      getBaseUrlForTeam: mockGetBaseUrlForTeam,
      getBaseUrlForUser: mockGetBaseUrlForUser,
    })),
  };
});

vi.mock("../di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: mockGetOrganizationUrlService,
}));

describe("getBookingOrganizationBaseUrl", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockGetBaseUrlForTeam.mockResolvedValue("https://team.example.com");
    mockGetBaseUrlForUser.mockResolvedValue("https://user.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns WEBAPP_URL without touching the service when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(getBookingOrganizationBaseUrl({ teamId: 3, organizerUserId: 5 })).resolves.toBe(WEBAPP_URL);
    expect(mockGetOrganizationUrlService).not.toHaveBeenCalled();
    expect(mockGetBaseUrlForTeam).not.toHaveBeenCalled();
    expect(mockGetBaseUrlForUser).not.toHaveBeenCalled();
  });

  it("resolves through the team when the booking has one", async () => {
    await expect(getBookingOrganizationBaseUrl({ teamId: 3, organizerUserId: 5 })).resolves.toBe(
      "https://team.example.com"
    );
    expect(mockGetBaseUrlForTeam).toHaveBeenCalledWith({ teamId: 3 });
    expect(mockGetBaseUrlForUser).not.toHaveBeenCalled();
  });

  it("resolves through the organizer when the booking has no team", async () => {
    await expect(getBookingOrganizationBaseUrl({ teamId: null, organizerUserId: 5 })).resolves.toBe(
      "https://user.example.com"
    );
    expect(mockGetBaseUrlForUser).toHaveBeenCalledWith({ userId: 5 });
    expect(mockGetBaseUrlForTeam).not.toHaveBeenCalled();
  });

  it("delegates to the organizer lookup when neither team nor organizer is known", async () => {
    mockGetBaseUrlForUser.mockResolvedValue(WEBAPP_URL);

    await expect(getBookingOrganizationBaseUrl({ teamId: null, organizerUserId: null })).resolves.toBe(
      WEBAPP_URL
    );
    expect(mockGetBaseUrlForUser).toHaveBeenCalledWith({ userId: null });
    expect(mockGetBaseUrlForTeam).not.toHaveBeenCalled();
  });
});
