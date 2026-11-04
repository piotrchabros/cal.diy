import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveMemberSharingTeamIds = vi.fn();
const mockGetWebhooks = vi.fn();
const mockFindBooking = vi.fn();

vi.mock("@calcom/features/notetaker/lib/webhookSharingTeam", () => ({
  resolveMemberSharingTeamIds: (...args: unknown[]) => mockResolveMemberSharingTeamIds(...args),
}));
vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({
  default: (...args: unknown[]) => mockGetWebhooks(...args),
}));
vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({
  BookingRepository: class {
    findByUidIncludeEventTypeAndReferences = (...args: unknown[]) => mockFindBooking(...args);
    updateBookingStatus = vi.fn();
  },
}));
vi.mock("@calcom/features/webhooks/lib/scheduleTrigger", () => ({
  cancelNoShowTasksForBooking: vi.fn(),
  deleteWebhookScheduledTriggers: vi.fn(),
}));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({ default: vi.fn() }));
vi.mock("@calcom/app-store/_utils/getCalendar", () => ({ getCalendar: vi.fn() }));
vi.mock("@calcom/app-store/delegationCredential", () => ({
  getDelegationCredentialOrRegularCredential: vi.fn(),
  getUsersCredentialsIncludeServiceAccountKey: vi.fn().mockResolvedValue([]),
}));
vi.mock("@calcom/emails/email-manager", () => ({ sendRequestRescheduleEmailAndSMS: vi.fn() }));
vi.mock("@calcom/features/conferencing/lib/videoClient", () => ({ deleteMeeting: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/getCalEventResponses", () => ({
  getCalEventResponses: () => ({ responses: {}, userFieldsResponses: {} }),
}));
vi.mock("@calcom/lib/builders/CalendarEvent/builder", () => ({
  CalendarEventBuilder: class {
    calendarEvent = {};
    rescheduleLink = "";
    init = vi.fn();
  },
}));
vi.mock("@calcom/lib/builders/CalendarEvent/director", () => ({
  CalendarEventDirector: class {
    setBuilder = vi.fn();
    setExistingBooking = vi.fn();
    setCancellationReason = vi.fn();
    buildForRescheduleEmail = vi.fn();
    buildWithoutEventTypeForRescheduleEmail = vi.fn();
  },
}));
vi.mock("@calcom/lib/server/service/BookingWebhookFactory", () => ({
  BookingWebhookFactory: class {
    createCancelledEventPayload = vi.fn().mockReturnValue({});
  },
}));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock("@calcom/lib/getTeamIdFromEventType", () => ({
  getTeamIdFromEventType: vi.fn().mockResolvedValue(null),
}));
vi.mock("@calcom/lib/getOrgIdFromMemberOrTeamId", () => ({ default: vi.fn().mockResolvedValue(null) }));
vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

import { BookingStatus } from "@calcom/prisma/enums";
import { requestRescheduleHandler } from "./requestReschedule.handler";

const eventType = {
  teamId: null,
  userId: 11,
  parentId: null,
  slug: "intro",
  title: "Intro",
  length: 30,
  hideOrganizerEmail: false,
  customReplyToEmail: null,
  bookingFields: null,
  metadata: null,
  team: null,
  notetakerSettings: { sharingMode: "TEAM", sharingTeam: { id: 3, name: "Sales" } },
};

const booking = {
  id: 101,
  uid: "booking-uid",
  userId: 11,
  status: BookingStatus.ACCEPTED,
  user: { id: 11, email: "owner@example.com" },
  title: "Intro",
  description: null,
  startTime: new Date("2099-01-01T10:00:00.000Z"),
  endTime: new Date("2099-01-01T11:00:00.000Z"),
  eventTypeId: 5,
  userPrimaryEmail: null,
  metadata: {},
  eventType,
  location: null,
  attendees: [{ email: "guest@example.com", name: "Guest", locale: "en", timeZone: "UTC" }],
  references: [],
  customInputs: null,
  dynamicEventSlugRef: null,
  dynamicGroupSlugRef: null,
  destinationCalendar: null,
  smsReminderNumber: null,
  responses: {},
  iCalUID: null,
  iCalSequence: 0,
};

const requestReschedule = () =>
  requestRescheduleHandler({
    ctx: { user: { id: 11, email: "owner@example.com", locale: "en", timeZone: "UTC" } } as never,
    input: { bookingUid: "booking-uid", rescheduleReason: "Conflict" },
    source: "WEBAPP",
  });

describe("requestRescheduleHandler member sharing teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindBooking.mockResolvedValue(booking);
    mockGetWebhooks.mockResolvedValue([]);
  });

  it("passes the resolved sharing teams alongside the existing team ids", async () => {
    mockResolveMemberSharingTeamIds.mockResolvedValue([3]);

    await requestReschedule();

    expect(mockResolveMemberSharingTeamIds).toHaveBeenCalledWith(
      { ownerUserId: 11, eventType, bookingMetadata: {} },
      expect.anything()
    );
    expect(mockGetWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 11,
        eventTypeId: 5,
        teamId: null,
        triggerEvent: "BOOKING_CANCELLED",
        memberSharingTeamIds: [3],
      })
    );
  });

  it("falls back to no sharing teams when resolving fails", async () => {
    mockResolveMemberSharingTeamIds.mockRejectedValue(new Error("db down"));

    await requestReschedule();

    expect(mockGetWebhooks).toHaveBeenCalledWith(expect.objectContaining({ memberSharingTeamIds: [] }));
  });
});
