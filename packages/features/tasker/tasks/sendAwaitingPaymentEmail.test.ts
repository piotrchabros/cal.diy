import { WEBSITE_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetBooking, mockFindPayment, mockSendEmail } = vi.hoisted(() => ({
  mockGetBooking: vi.fn(),
  mockFindPayment: vi.fn(),
  mockSendEmail: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: {} }));

vi.mock("@calcom/emails/email-manager", () => ({
  sendAwaitingPaymentEmailAndSMS: mockSendEmail,
}));

vi.mock("@calcom/features/bookings/lib/payment/getBooking", () => ({
  getBooking: mockGetBooking,
}));

vi.mock("@calcom/features/bookings/repositories/PrismaBookingPaymentRepository", () => ({
  PrismaBookingPaymentRepository: class {
    findByIdForAwaitingPaymentEmail = mockFindPayment;
  },
}));

vi.mock("@calcom/features/bookings/repositories/AttendeeRepository", () => ({
  AttendeeRepository: class {
    findByBookingIdAndSeatReference = vi.fn();
  },
}));

import { sendAwaitingPaymentEmail } from "./sendAwaitingPaymentEmail";

const ORG_URL = "https://acme.cal.example";

describe("sendAwaitingPaymentEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBooking.mockResolvedValue({
      booking: { paid: false, startTime: new Date("2026-01-01T10:00:00.000Z") },
      evt: {
        bookerUrl: ORG_URL,
        attendees: [{ name: "Booker", email: "booker@example.com" }],
      },
      eventType: { metadata: null },
    });
    mockFindPayment.mockResolvedValue({
      uid: "payment-uid",
      success: false,
      paymentOption: "ON_BOOKING",
      amount: 1000,
      currency: "usd",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const sentPaymentLink = (): string => mockSendEmail.mock.calls[0][0].paymentInfo.link;

  it("builds the payment link on the organization booker URL when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await sendAwaitingPaymentEmail(JSON.stringify({ bookingId: 1, paymentId: 2 }));

    expect(sentPaymentLink().startsWith(`${ORG_URL}/payment/payment-uid?`)).toBe(true);
  });

  it("keeps the payment link on WEBSITE_URL when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await sendAwaitingPaymentEmail(JSON.stringify({ bookingId: 1, paymentId: 2 }));

    expect(sentPaymentLink().startsWith(`${WEBSITE_URL}/payment/payment-uid?`)).toBe(true);
  });
});
