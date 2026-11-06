import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPathWithQuery, getOrganizerOrganizationRedirect } from "./getOrganizerOrganizationRedirect";

const { mockGetBaseUrlForUser, mockGetBaseUrlForTeam, mockGetOrganizationUrlService, mockLogError } =
  vi.hoisted(() => {
    const mockGetBaseUrlForUser = vi.fn();
    const mockGetBaseUrlForTeam = vi.fn();
    return {
      mockGetBaseUrlForUser,
      mockGetBaseUrlForTeam,
      mockGetOrganizationUrlService: vi.fn(() => ({
        getBaseUrlForUser: mockGetBaseUrlForUser,
        getBaseUrlForTeam: mockGetBaseUrlForTeam,
      })),
      mockLogError: vi.fn(),
    };
  });

vi.mock("../di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: mockGetOrganizationUrlService,
}));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ error: mockLogError }) },
}));

const requestFrom = (host: string) => new Headers({ host });
const PATH = "/booking/abc?x=1";

describe("getOrganizerOrganizationRedirect", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockGetBaseUrlForUser.mockResolvedValue("https://cal.acme.com");
    mockGetBaseUrlForTeam.mockResolvedValue("https://cal.team.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns null without any lookup when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: 1,
        teamId: null,
        path: PATH,
      })
    ).resolves.toBeNull();
    expect(mockGetOrganizationUrlService).not.toHaveBeenCalled();
  });

  it("returns null when there is neither an organizer nor a team", async () => {
    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: null,
        teamId: null,
        path: PATH,
      })
    ).resolves.toBeNull();
    expect(mockGetOrganizationUrlService).not.toHaveBeenCalled();
  });

  it.each([
    "cal.acme.com",
    "CAL.ACME.COM",
    "cal.acme.com:3000",
    "cal.acme.com.",
  ])("returns null when the request is already on the organizer's host (%s)", async (host) => {
    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom(host),
        organizerUserId: 1,
        teamId: null,
        path: PATH,
      })
    ).resolves.toBeNull();
  });

  it("redirects to the organizer's host when the request is on another host", async () => {
    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: 1,
        teamId: null,
        path: PATH,
      })
    ).resolves.toBe("https://cal.acme.com/booking/abc?x=1");
    expect(mockGetBaseUrlForUser).toHaveBeenCalledWith({ userId: 1 });
  });

  it("prefers the organizer over the team", async () => {
    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: 1,
        teamId: 2,
        path: PATH,
      })
    ).resolves.toBe("https://cal.acme.com/booking/abc?x=1");
    expect(mockGetBaseUrlForTeam).not.toHaveBeenCalled();
  });

  it("uses the team when there is no organizer", async () => {
    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: null,
        teamId: 2,
        path: PATH,
      })
    ).resolves.toBe("https://cal.team.com/booking/abc?x=1");
    expect(mockGetBaseUrlForTeam).toHaveBeenCalledWith({ teamId: 2 });
    expect(mockGetBaseUrlForUser).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from the base URL", async () => {
    mockGetBaseUrlForUser.mockResolvedValue("https://cal.acme.com/");

    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: 1,
        teamId: null,
        path: PATH,
      })
    ).resolves.toBe("https://cal.acme.com/booking/abc?x=1");
  });

  it("returns null and logs when the lookup fails", async () => {
    mockGetBaseUrlForUser.mockRejectedValue(new Error("db down"));

    await expect(
      getOrganizerOrganizationRedirect({
        headers: requestFrom("app.cal.com"),
        organizerUserId: 1,
        teamId: 2,
        path: PATH,
      })
    ).resolves.toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
      organizerUserId: 1,
      teamId: 2,
      message: "db down",
    });
  });
});

describe("buildPathWithQuery", () => {
  it("skips excluded keys", () => {
    expect(buildPathWithQuery("/booking/abc", { uid: "abc", x: "1" }, ["uid"])).toBe("/booking/abc?x=1");
  });

  it("appends each array value", () => {
    expect(buildPathWithQuery("/p", { a: ["1", "2"] }, [])).toBe("/p?a=1&a=2");
  });

  it("skips undefined values", () => {
    expect(buildPathWithQuery("/p", { a: undefined, b: "2" }, [])).toBe("/p?b=2");
  });

  it("returns the bare pathname when no query remains", () => {
    expect(buildPathWithQuery("/p", {}, [])).toBe("/p");
    expect(buildPathWithQuery("/p", { uid: "abc" }, ["uid"])).toBe("/p");
  });

  it("encodes special characters", () => {
    expect(buildPathWithQuery("/p", { email: "a+b@x.com", q: "a b&c" }, [])).toBe(
      "/p?email=a%2Bb%40x.com&q=a+b%26c"
    );
  });
});
