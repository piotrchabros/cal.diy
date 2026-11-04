import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));

vi.mock("@calcom/prisma", () => ({ default: { booking: { findUnique: findUniqueMock } } }));
vi.mock("@calcom/emails/email-manager", () => ({
  sendOrganizerRequestEmail: vi.fn(),
  sendAttendeeRequestEmailAndSMS: vi.fn(),
}));
vi.mock("@calcom/features/bookings/lib/getWebhookPayloadForBooking", () => ({
  getWebhookPayloadForBooking: vi.fn().mockReturnValue({}),
}));
vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({ default: vi.fn().mockResolvedValue([]) }));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({ default: vi.fn() }));
vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {},
}));
vi.mock("@calcom/features/notetaker/lib/webhookSharingTeam", () => ({
  resolveMemberSharingTeamIds: vi.fn(),
}));

import { resolveMemberSharingTeamIds } from "@calcom/features/notetaker/lib/webhookSharingTeam";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import { handleBookingRequested } from "./handleBookingRequested";

const booking = {
  smsReminderNumber: null,
  eventType: null,
  eventTypeId: 7,
  userId: 101,
  id: 42,
};

const evt = { attendees: [{}] } as unknown as CalendarEvent;

describe("handleBookingRequested member sharing teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the resolved member sharing team ids to getWebhooks", async () => {
    const eventType = {
      teamId: null,
      userId: 101,
      team: null,
      notetakerSettings: { sharingMode: "TEAM", sharingTeam: { id: 55, name: "Sales" } },
    };
    findUniqueMock.mockResolvedValue({ userId: 101, metadata: {}, eventType });
    vi.mocked(resolveMemberSharingTeamIds).mockResolvedValue([55]);

    await handleBookingRequested({ evt, booking });

    expect(findUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42 } }));
    expect(resolveMemberSharingTeamIds).toHaveBeenCalledWith(
      { ownerUserId: 101, eventType, bookingMetadata: {} },
      expect.anything()
    );
    expect(getWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerEvent: WebhookTriggerEvents.BOOKING_REQUESTED,
        memberSharingTeamIds: [55],
      })
    );
  });

  it("falls back to no member sharing teams when resolving them fails", async () => {
    findUniqueMock.mockRejectedValue(new Error("db down"));

    await handleBookingRequested({ evt, booking });

    expect(getWebhooks).toHaveBeenCalledWith(expect.objectContaining({ memberSharingTeamIds: [] }));
  });
});
