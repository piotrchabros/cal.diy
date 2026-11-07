import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingOrganizationBaseUrl = vi.fn();

vi.mock("@calcom/features/organizations/lib/getBookingOrganizationBaseUrl", () => ({
  getBookingOrganizationBaseUrl: (...args: unknown[]) => mockGetBookingOrganizationBaseUrl(...args),
}));
vi.mock("@calcom/app-store/delegationCredential", () => ({
  getUsersCredentialsIncludeServiceAccountKey: vi.fn(),
}));
vi.mock("@calcom/features/bookings/lib/BookingEmailSmsHandler", () => ({ BookingEmailSmsHandler: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/EventManager", () => ({ default: vi.fn() }));
vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({ BookingRepository: vi.fn() }));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/features/eventtypes/di/EventTypeService.container", () => ({
  getEventTypeService: vi.fn(),
}));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

import type { Booking } from "./addGuests.handler";
import { buildCalendarEvent } from "./addGuests.handler";

const organizer = {
  id: 11,
  email: "owner@example.com",
  name: "Owner",
  timeZone: "UTC",
  locale: "en",
  hideBranding: false,
  profiles: [],
};

const buildBooking = (eventType: { teamId: number | null } | null) =>
  ({
    title: "Discovery call",
    description: null,
    startTime: new Date("2099-01-01T10:00:00.000Z"),
    endTime: new Date("2099-01-01T11:00:00.000Z"),
    userPrimaryEmail: null,
    uid: "booking-uid",
    iCalUID: null,
    location: null,
    destinationCalendar: null,
    eventTypeId: null,
    eventType,
    userId: 11,
    user: { destinationCalendar: null, profiles: [] },
    references: [],
  }) as unknown as Booking;

describe("buildCalendarEvent bookerUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBookingOrganizationBaseUrl.mockResolvedValue("https://acme.example.com");
  });

  it("resolves the booker URL from the event type's team for team bookings", async () => {
    const evt = await buildCalendarEvent(buildBooking({ teamId: 5 }), organizer as never, []);

    expect(evt.bookerUrl).toBe("https://acme.example.com");
    expect(mockGetBookingOrganizationBaseUrl).toHaveBeenCalledWith({ teamId: 5, organizerUserId: 11 });
  });

  it("resolves the booker URL from the organizer for personal bookings", async () => {
    const evt = await buildCalendarEvent(buildBooking(null), organizer as never, []);

    expect(evt.bookerUrl).toBe("https://acme.example.com");
    expect(mockGetBookingOrganizationBaseUrl).toHaveBeenCalledWith({ teamId: null, organizerUserId: 11 });
  });
});
