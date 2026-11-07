import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  bookingFindMany,
  reminderMailFindMany,
  reminderMailCreate,
  sendOrganizerRequestReminderEmail,
  getBookingOrganizationBaseUrl,
} = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  reminderMailFindMany: vi.fn(),
  reminderMailCreate: vi.fn(),
  sendOrganizerRequestReminderEmail: vi.fn(),
  getBookingOrganizationBaseUrl: vi.fn(),
}));

vi.mock("@calcom/prisma", () => {
  const prisma = {
    booking: { findMany: bookingFindMany },
    reminderMail: { findMany: reminderMailFindMany, create: reminderMailCreate },
  };
  return { default: prisma, prisma, bookingMinimalSelect: {} };
});

vi.mock("@calcom/emails/email-manager", () => ({
  sendOrganizerRequestReminderEmail,
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async () => (key: string) => key),
}));

vi.mock("@calcom/features/organizations/lib/getBookingOrganizationBaseUrl", () => ({
  getBookingOrganizationBaseUrl,
}));

import { POST } from "../route";

const CRON_URL = "http://localhost/api/cron/bookingReminder";

function buildPendingBooking() {
  return {
    id: 11,
    uid: "booking-uid",
    title: "Intro call",
    description: null,
    customInputs: null,
    userPrimaryEmail: null,
    location: null,
    startTime: new Date("2030-01-01T10:00:00.000Z"),
    endTime: new Date("2030-01-01T10:30:00.000Z"),
    attendees: [{ name: "Attendee", email: "attendee@example.com", timeZone: "UTC", locale: "en" }],
    responses: { name: "Attendee", email: "attendee@example.com" },
    destinationCalendar: null,
    user: {
      id: 7,
      email: "organizer@example.com",
      name: "Organizer",
      username: "organizer",
      locale: "en",
      timeZone: "UTC",
      destinationCalendar: null,
      isPlatformManaged: false,
      platformOAuthClients: [],
    },
    eventType: {
      teamId: 42,
      recurringEvent: null,
      bookingFields: null,
      metadata: null,
    },
  };
}

function callPost(request: NextRequest) {
  return POST(request, { params: Promise.resolve({}) });
}

describe("/api/cron/bookingReminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_API_KEY", "test-cron-key");
    bookingFindMany.mockReset();
    bookingFindMany.mockResolvedValueOnce([buildPendingBooking()]).mockResolvedValue([]);
    reminderMailFindMany.mockResolvedValue([]);
    reminderMailCreate.mockResolvedValue({});
    sendOrganizerRequestReminderEmail.mockResolvedValue(undefined);
    getBookingOrganizationBaseUrl.mockResolvedValue("https://acme.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns 401 for a wrong api key", async () => {
    const response = await callPost(new NextRequest(CRON_URL, { headers: { authorization: "wrong-key" } }));

    expect(response.status).toBe(401);
    expect(sendOrganizerRequestReminderEmail).not.toHaveBeenCalled();
  });

  test("sends the reminder with the booking organization's base url as bookerUrl", async () => {
    const response = await callPost(
      new NextRequest(CRON_URL, { method: "POST", headers: { authorization: "test-cron-key" } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notificationsSent: 1 });
    expect(getBookingOrganizationBaseUrl).toHaveBeenCalledWith({ teamId: 42, organizerUserId: 7 });
    expect(sendOrganizerRequestReminderEmail).toHaveBeenCalledOnce();
    expect(sendOrganizerRequestReminderEmail.mock.calls[0][0].bookerUrl).toBe("https://acme.example.com");
  });

  test("passes a null teamId when the booking has no event type", async () => {
    bookingFindMany.mockReset();
    bookingFindMany
      .mockResolvedValueOnce([{ ...buildPendingBooking(), eventType: null }])
      .mockResolvedValue([]);

    await callPost(
      new NextRequest(CRON_URL, { method: "POST", headers: { authorization: "test-cron-key" } })
    );

    expect(getBookingOrganizationBaseUrl).toHaveBeenCalledWith({ teamId: null, organizerUserId: 7 });
    expect(sendOrganizerRequestReminderEmail.mock.calls[0][0].bookerUrl).toBe("https://acme.example.com");
  });
});
