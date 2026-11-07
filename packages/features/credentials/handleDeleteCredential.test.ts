import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, sendCancelledEmailsAndSMSMock, getBookingOrganizationBaseUrlMock } = vi.hoisted(() => {
  const prismaMock = {
    credential: { findFirst: vi.fn(), delete: vi.fn() },
    eventType: { findMany: vi.fn(), update: vi.fn() },
    booking: { findMany: vi.fn(), updateMany: vi.fn() },
    payment: { updateMany: vi.fn(), deleteMany: vi.fn() },
    attendee: { deleteMany: vi.fn() },
    bookingReference: { updateMany: vi.fn() },
    user: { update: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    prismaMock,
    sendCancelledEmailsAndSMSMock: vi.fn(),
    getBookingOrganizationBaseUrlMock: vi.fn(),
  };
});

vi.mock("@calcom/prisma", () => ({
  prisma: prismaMock,
  default: prismaMock,
  bookingMinimalSelect: {
    id: true,
    title: true,
    description: true,
    customInputs: true,
    startTime: true,
    endTime: true,
    attendees: true,
    metadata: true,
  },
}));

vi.mock("@calcom/emails/email-manager", () => ({
  sendCancelledEmailsAndSMS: sendCancelledEmailsAndSMSMock,
}));

vi.mock("@calcom/features/bookings/lib/payment/deletePayment", () => ({
  deletePayment: vi.fn(),
}));

vi.mock("@calcom/features/webhooks/lib/scheduleTrigger", () => ({
  deleteWebhookScheduledTriggers: vi.fn(),
}));

vi.mock("@calcom/app-store/_utils/getCalendar", () => ({
  getCalendar: vi.fn(),
}));

vi.mock("@calcom/features/organizations/lib/getBookingOrganizationBaseUrl", () => ({
  getBookingOrganizationBaseUrl: getBookingOrganizationBaseUrlMock,
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async () => (key: string) => key),
}));

import handleDeleteCredential from "./handleDeleteCredential";

describe("handleDeleteCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) =>
      callback(prismaMock)
    );
    prismaMock.credential.findFirst.mockResolvedValue({
      id: 1,
      type: "stripe_payment",
      key: {},
      userId: 10,
      teamId: null,
      appId: "stripe",
      invalid: false,
      user: { email: "organizer@example.com" },
      delegationCredentialId: null,
      app: { slug: "stripe", categories: ["payment"], dirName: "stripepayment" },
    });
    prismaMock.eventType.findMany.mockResolvedValue([
      {
        id: 100,
        locations: null,
        destinationCalendar: null,
        price: 1000,
        currency: "usd",
        metadata: {},
      },
    ]);
    prismaMock.booking.findMany.mockResolvedValue([
      {
        id: 500,
        uid: "booking-uid",
        title: "Paid meeting",
        description: null,
        customInputs: null,
        startTime: new Date("2030-01-01T10:00:00Z"),
        endTime: new Date("2030-01-01T10:30:00Z"),
        attendees: [{ name: "Booker", email: "booker@example.com", timeZone: "UTC", locale: "en" }],
        metadata: null,
        recurringEventId: null,
        userId: 10,
        responses: { name: "Booker", email: "booker@example.com" },
        user: {
          id: 10,
          credentials: [],
          email: "organizer@example.com",
          timeZone: "UTC",
          name: "Organizer",
          destinationCalendar: null,
          locale: "en",
          profiles: [{ organizationId: 7 }],
        },
        location: null,
        references: [],
        payment: [{ id: 900 }],
        paid: false,
        eventType: {
          recurringEvent: null,
          title: "Paid meeting",
          bookingFields: [],
          seatsPerTimeSlot: null,
          seatsShowAttendees: false,
          eventName: null,
          hideOrganizerEmail: false,
          team: { id: 42, name: "Acme Team" },
          metadata: {},
        },
        eventTypeId: 100,
        destinationCalendar: null,
      },
    ]);
    getBookingOrganizationBaseUrlMock.mockResolvedValue("https://acme.example.com");
  });

  it("passes the booking organization's bookerUrl to the cancellation emails of unpaid bookings", async () => {
    await handleDeleteCredential({ userId: 10, userMetadata: null, credentialId: 1 });

    expect(getBookingOrganizationBaseUrlMock).toHaveBeenCalledWith({ teamId: 42, organizerUserId: 10 });
    expect(sendCancelledEmailsAndSMSMock).toHaveBeenCalledTimes(1);
    expect(sendCancelledEmailsAndSMSMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ uid: "booking-uid", bookerUrl: "https://acme.example.com" })
    );
  });
});
