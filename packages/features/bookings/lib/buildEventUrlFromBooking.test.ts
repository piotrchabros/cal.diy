import { constantsScenarios } from "@calcom/lib/__mocks__/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventUrlFromBooking } from "./buildEventUrlFromBooking";

const { getBaseUrl } = vi.hoisted(() => ({ getBaseUrl: vi.fn() }));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl }),
}));

const WEBAPP_URL = "https://buildEventTest.example";
beforeEach(() => {
  constantsScenarios.set({ WEBAPP_URL });
  getBaseUrl.mockReset();
  getBaseUrl.mockResolvedValue(WEBAPP_URL);
});

describe("buildEventUrlFromBooking organization base URL", () => {
  it("uses the team's parent organization for a team event", async () => {
    getBaseUrl.mockResolvedValue("https://org.example.com");

    const result = await buildEventUrlFromBooking({
      eventType: { slug: "30min", team: { slug: "engineering", parentId: 123 } },
      profileEnrichedBookingUser: { profile: { organizationId: 456, username: "john" } },
      dynamicGroupSlugRef: null,
    });

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: 123 });
    expect(result).toBe("https://org.example.com/team/engineering/30min");
  });

  it("uses the organizer's organization for a personal event", async () => {
    getBaseUrl.mockResolvedValue("https://org.example.com");

    const result = await buildEventUrlFromBooking({
      eventType: { slug: "30min", team: null },
      profileEnrichedBookingUser: { profile: { organizationId: 456, username: "john" } },
      dynamicGroupSlugRef: null,
    });

    expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: 456 });
    expect(result).toBe("https://org.example.com/john/30min");
  });
});

describe("buildEventUrlFromBooking", () => {
  describe("Non Organization", () => {
    it("should correctly build the event URL for a team event booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: {
            slug: "engineering",
            parentId: 123,
          },
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId: null,
            username: "john",
          },
        },
        dynamicGroupSlugRef: null,
      };
      const expectedUrl = `${WEBAPP_URL}/team/engineering/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });

    it("should correctly build the event URL for a dynamic group booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: null,
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId: null,
            username: "john",
          },
        },
        dynamicGroupSlugRef: "john+jane",
      };
      const expectedUrl = `${WEBAPP_URL}/john+jane/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });

    it("should correctly build the event URL for a personal booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: null,
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId: null,
            username: "john",
          },
        },
        dynamicGroupSlugRef: null,
      };
      const expectedUrl = `${WEBAPP_URL}/john/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });
  });

  describe("Organization", () => {
    const organizationId = 123;
    it("should correctly build the event URL for a team event booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: {
            slug: "engineering",
            parentId: 123,
          },
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId,
            username: "john",
          },
        },
        dynamicGroupSlugRef: null,
      };
      const expectedUrl = `${WEBAPP_URL}/team/engineering/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });

    it("should correctly build the event URL for a dynamic group booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: null,
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId,
            username: "john",
          },
        },
        dynamicGroupSlugRef: "john+jane",
      };
      const expectedUrl = `${WEBAPP_URL}/john+jane/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });

    it("should correctly build the event URL for a personal booking", async () => {
      const booking = {
        eventType: {
          slug: "30min",
          team: null,
        },
        profileEnrichedBookingUser: {
          profile: {
            organizationId,
            username: "john",
          },
        },
        dynamicGroupSlugRef: null,
      };
      const expectedUrl = `${WEBAPP_URL}/john/30min`;
      const result = await buildEventUrlFromBooking(booking);
      expect(result).toBe(expectedUrl);
    });
  });

  it("should throw if the username isn't set", async () => {
    const booking = {
      eventType: {
        slug: "30min",
        team: null,
      },
      profileEnrichedBookingUser: {
        profile: {
          organizationId: null,
          username: null,
        },
      },
      dynamicGroupSlugRef: null,
    };
    await expect(() => buildEventUrlFromBooking(booking)).rejects.toThrow(
      "No username found for booking user."
    );
  });
});
