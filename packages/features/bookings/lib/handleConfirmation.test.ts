import type { PrismaClient } from "@calcom/prisma";
import { BookingStatus, WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/features/bookings/lib/EventManager", () => ({
  default: class {
    create = vi.fn().mockResolvedValue({ results: [], referencesToCreate: [] });
  },
}));
vi.mock("@calcom/emails/email-manager", () => ({ sendScheduledEmailsAndSMS: vi.fn() }));
vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({ default: vi.fn().mockResolvedValue([]) }));
vi.mock("@calcom/features/webhooks/lib/scheduleTrigger", () => ({ scheduleTrigger: vi.fn() }));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({ default: vi.fn() }));
vi.mock("./handleNewBooking/scheduleNoShowTriggers", () => ({ scheduleNoShowTriggers: vi.fn() }));
vi.mock("@calcom/lib/CalEventParser", () => ({ getVideoCallUrlFromCalEvent: vi.fn().mockReturnValue("") }));
vi.mock("@calcom/lib/tracing/factory", () => ({
  distributedTracing: {
    createSpan: vi.fn(),
    getTracingLogger: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {},
}));
vi.mock("@calcom/features/notetaker/lib/webhookSharingTeam", () => ({
  resolveMemberSharingTeamIds: vi.fn(),
}));

import { resolveMemberSharingTeamIds } from "@calcom/features/notetaker/lib/webhookSharingTeam";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import { handleConfirmation } from "./handleConfirmation";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const prisma = { booking: { findUnique: findUniqueMock, update: updateMock } } as unknown as PrismaClient;

const booking = {
  startTime: new Date("2026-01-01T10:00:00Z"),
  id: 42,
  uid: "booking-uid",
  eventType: null,
  metadata: {},
  eventTypeId: 7,
  smsReminderNumber: null,
  userId: 101,
  location: null,
  status: BookingStatus.PENDING,
};

function runConfirmation() {
  return handleConfirmation({
    user: { username: "organizer" } as Parameters<typeof handleConfirmation>[0]["user"],
    evt: { attendees: [] } as unknown as CalendarEvent,
    prisma,
    bookingId: booking.id,
    booking,
    traceContext: {} as Parameters<typeof handleConfirmation>[0]["traceContext"],
  });
}

describe("handleConfirmation member sharing teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({ ...booking, eventType: null, attendees: [], responses: {} });
  });

  it("passes the resolved member sharing team ids to the booking and meeting getWebhooks calls", async () => {
    const eventType = {
      teamId: 55,
      userId: null,
      team: { id: 55, name: "Sales", parentId: null },
      notetakerSettings: { sharingMode: "TEAM", sharingTeam: null },
    };
    findUniqueMock.mockResolvedValue({ userId: 101, metadata: {}, eventType });
    vi.mocked(resolveMemberSharingTeamIds).mockResolvedValue([55]);

    await runConfirmation();

    expect(resolveMemberSharingTeamIds).toHaveBeenCalledWith(
      { ownerUserId: 101, eventType, bookingMetadata: {} },
      expect.anything()
    );
    for (const triggerEvent of [
      WebhookTriggerEvents.BOOKING_CREATED,
      WebhookTriggerEvents.MEETING_STARTED,
      WebhookTriggerEvents.MEETING_ENDED,
    ]) {
      expect(getWebhooks).toHaveBeenCalledWith(
        expect.objectContaining({ triggerEvent, memberSharingTeamIds: [55] })
      );
    }
  });

  it("falls back to no member sharing teams when resolving them fails", async () => {
    findUniqueMock.mockResolvedValue({ userId: 101, metadata: {}, eventType: null });
    vi.mocked(resolveMemberSharingTeamIds).mockRejectedValue(new Error("lookup failed"));

    await runConfirmation();

    expect(updateMock).toHaveBeenCalled();
    expect(getWebhooks).toHaveBeenCalledTimes(3);
    expect(getWebhooks).toHaveBeenCalledWith(expect.objectContaining({ memberSharingTeamIds: [] }));
  });
});
