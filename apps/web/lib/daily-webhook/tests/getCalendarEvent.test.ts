import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getBookingResponse } from "../getBooking";
import { getCalendarEvent } from "../getCalendarEvent";

const getBaseUrlForUser = vi.fn();

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForUser }),
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async () => (key: string) => key),
}));

const buildBooking = (user: { id: number } | null) =>
  ({
    title: "Intro call",
    description: null,
    startTime: new Date("2026-11-10T10:00:00.000Z"),
    endTime: new Date("2026-11-10T10:30:00.000Z"),
    uid: "booking-uid",
    userPrimaryEmail: null,
    user: user && { ...user, email: "host@example.com", name: "Host", timeZone: "UTC", locale: "en" },
    attendees: [{ id: 1, name: "Guest", email: "guest@example.com", timeZone: "UTC", locale: "en" }],
    eventType: null,
  }) as unknown as getBookingResponse;

describe("getCalendarEvent", () => {
  beforeEach(() => {
    getBaseUrlForUser.mockReset();
  });

  it("sets bookerUrl from the organizer's organization", async () => {
    getBaseUrlForUser.mockResolvedValue("https://org.example.com");

    const evt = await getCalendarEvent(buildBooking({ id: 42 }));

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(evt.bookerUrl).toBe("https://org.example.com");
  });

  it("asks for the fallback base URL when the booking has no organizer", async () => {
    getBaseUrlForUser.mockResolvedValue("https://app.example.com");

    const evt = await getCalendarEvent(buildBooking(null));

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: undefined });
    expect(evt.bookerUrl).toBe("https://app.example.com");
    expect(evt.organizer.name).toBe("Nameless");
  });
});
