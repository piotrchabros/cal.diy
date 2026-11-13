import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockGetBaseUrl, mockGetBaseUrlForUser } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockGetBaseUrl: vi.fn(async () => "https://org.example"),
  mockGetBaseUrlForUser: vi.fn(async () => "https://user.example"),
}));

vi.mock("@calcom/prisma", () => ({
  default: { booking: { findUnique: mockFindUnique } },
  prisma: { booking: { findUnique: mockFindUnique } },
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async () => vi.fn(() => "translated")),
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({
    getBaseUrl: mockGetBaseUrl,
    getBaseUrlForUser: mockGetBaseUrlForUser,
  }),
}));

import buildCalendarEvent from "./buildCalendarEvent";

const buildBooking = (team: { id: number; isOrganization: boolean; parentId: number | null } | null) => ({
  uid: "booking-uid",
  title: "CRM Meeting",
  startTime: new Date("2026-01-01T10:00:00.000Z"),
  endTime: new Date("2026-01-01T10:30:00.000Z"),
  location: null,
  responses: { name: "Attendee", email: "attendee@example.com" },
  customInputs: null,
  user: {
    id: 42,
    name: "Organizer",
    email: "organizer@example.com",
    locale: "en",
    username: "organizer",
    timeZone: "UTC",
    timeFormat: 24,
  },
  eventType: {
    slug: "crm-event",
    bookingFields: null,
    team,
  },
  attendees: [
    {
      email: "attendee@example.com",
      locale: "en",
      name: "Attendee",
      timeZone: "UTC",
      phoneNumber: null,
    },
  ],
  references: [],
});

describe("buildCalendarEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves bookerUrl from the team's parent organization when present", async () => {
    mockFindUnique.mockResolvedValue(buildBooking({ id: 3, isOrganization: false, parentId: 7 }));

    const calendarEvent = await buildCalendarEvent("booking-uid");

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 7 });
    expect(mockGetBaseUrlForUser).not.toHaveBeenCalled();
    expect(calendarEvent.bookerUrl).toBe("https://org.example");
  });

  it("resolves bookerUrl from the organization itself when the event type is organization-owned", async () => {
    mockFindUnique.mockResolvedValue(buildBooking({ id: 9, isOrganization: true, parentId: null }));

    const calendarEvent = await buildCalendarEvent("booking-uid");

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 9 });
    expect(mockGetBaseUrlForUser).not.toHaveBeenCalled();
    expect(calendarEvent.bookerUrl).toBe("https://org.example");
  });

  it("resolves bookerUrl from the organizer when the event type has no team", async () => {
    mockFindUnique.mockResolvedValue(buildBooking(null));

    const calendarEvent = await buildCalendarEvent("booking-uid");

    expect(mockGetBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(mockGetBaseUrl).not.toHaveBeenCalled();
    expect(calendarEvent.bookerUrl).toBe("https://user.example");
  });
});
