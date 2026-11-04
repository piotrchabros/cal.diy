import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveMemberSharingTeamIds = vi.fn();
const mockHandleWebhookTrigger = vi.fn();

vi.mock("@calcom/features/notetaker/lib/webhookSharingTeam", () => ({
  resolveMemberSharingTeamIds: (...args: unknown[]) => mockResolveMemberSharingTeamIds(...args),
}));
vi.mock("@calcom/features/bookings/lib/handleWebhookTrigger", () => ({
  handleWebhookTrigger: (...args: unknown[]) => mockHandleWebhookTrigger(...args),
}));
vi.mock("@calcom/features/bookings/services/BookingAccessService", () => ({
  BookingAccessService: class {
    doesUserIdHaveAccessToBooking = vi.fn().mockResolvedValue(true);
  },
}));
vi.mock("@calcom/app-store/delegationCredential", () => ({
  getUsersCredentialsIncludeServiceAccountKey: vi.fn(),
}));
vi.mock("@calcom/app-store/locations", () => ({ getLocationValueForDB: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({ sendDeclinedEmailsAndSMS: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/getAllCredentialsForUsersOnEvent/getAllCredentials", () => ({
  getAllCredentialsIncludeServiceAccountKey: vi.fn(),
}));
vi.mock("@calcom/features/bookings/lib/handleConfirmation", () => ({ handleConfirmation: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/payment/processPaymentRefund", () => ({
  processPaymentRefund: vi.fn(),
}));
vi.mock("@calcom/features/eventtypes/di/EventTypeService.container", () => ({
  getEventTypeService: vi.fn(),
}));
vi.mock("@calcom/features/bookings/lib/getCalEventResponses", () => ({
  getCalEventResponses: () => ({ responses: {} }),
}));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock("@calcom/lib/getTeamIdFromEventType", () => ({
  getTeamIdFromEventType: vi.fn().mockResolvedValue(null),
}));
vi.mock("@calcom/lib/getOrgIdFromMemberOrTeamId", () => ({ default: vi.fn().mockResolvedValue(null) }));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    booking: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    profile: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import { BookingStatus, WebhookTriggerEvents } from "@calcom/prisma/enums";
import { confirmHandler } from "./confirm.handler";

const booking = {
  id: 101,
  uid: "booking-uid",
  title: "Discovery call",
  description: null,
  customInputs: null,
  startTime: new Date("2099-01-01T10:00:00.000Z"),
  endTime: new Date("2099-01-01T11:00:00.000Z"),
  attendees: [],
  eventTypeId: null,
  responses: {},
  metadata: { notetakerSharingTeamId: "3" },
  userPrimaryEmail: null,
  eventType: null,
  location: null,
  userId: 11,
  user: {
    id: 11,
    username: "owner",
    email: "owner@example.com",
    timeZone: "UTC",
    timeFormat: 24,
    name: "Owner",
    destinationCalendar: null,
    locale: "en",
    hideBranding: false,
    profiles: [],
  },
  payment: [],
  destinationCalendar: null,
  paid: false,
  recurringEventId: null,
  status: BookingStatus.PENDING,
  smsReminderNumber: null,
  assignmentReason: [],
};

const reject = () =>
  confirmHandler({
    ctx: { user: { id: 11 }, traceContext: {} } as never,
    input: { bookingId: 101, confirmed: false, reason: "No", emailsEnabled: false },
  });

describe("confirmHandler reject member sharing teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.booking.findUniqueOrThrow).mockResolvedValue(booking as never);
  });

  it("passes the resolved sharing teams to the BOOKING_REJECTED subscribers", async () => {
    mockResolveMemberSharingTeamIds.mockResolvedValue([3]);

    await reject();

    expect(mockResolveMemberSharingTeamIds).toHaveBeenCalledWith(
      { ownerUserId: 11, eventType: null, bookingMetadata: { notetakerSharingTeamId: "3" } },
      expect.anything()
    );
    const { subscriberOptions } = mockHandleWebhookTrigger.mock.calls[0][0];
    expect(subscriberOptions.triggerEvent).toBe(WebhookTriggerEvents.BOOKING_REJECTED);
    expect(subscriberOptions.memberSharingTeamIds).toEqual([3]);
  });

  it("falls back to no sharing teams when resolving fails", async () => {
    mockResolveMemberSharingTeamIds.mockRejectedValue(new Error("db down"));

    await reject();

    expect(mockHandleWebhookTrigger.mock.calls[0][0].subscriberOptions.memberSharingTeamIds).toEqual([]);
  });
});
