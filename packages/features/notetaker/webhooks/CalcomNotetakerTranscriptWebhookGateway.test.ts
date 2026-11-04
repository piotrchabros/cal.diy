import type { WebhookSubscriber } from "@calcom/features/webhooks/lib/dto/types";
import type { EventPayloadType } from "@calcom/features/webhooks/lib/sendPayload";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerMeetingForWebhookRecord } from "../repositories/interfaces/IBookingNotetakerRepository";
import { CalcomNotetakerTranscriptWebhookGateway } from "./CalcomNotetakerTranscriptWebhookGateway";

const getWebhooksMock = vi.fn();
const sendOrSchedulePayloadMock = vi.fn();
const buildMock = vi.fn();
const fromBookingMock = vi.fn();

vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({
  default: (...args: unknown[]) => getWebhooksMock(...args),
}));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({
  default: (...args: unknown[]) => sendOrSchedulePayloadMock(...args),
}));
vi.mock("@calcom/features/CalendarEventBuilder", () => ({
  CalendarEventBuilder: { fromBooking: (...args: unknown[]) => fromBookingMock(...args) },
}));

function buildSubscriber(id: string): WebhookSubscriber {
  return {
    id,
    subscriberUrl: `https://crm.example/${id}`,
    payloadTemplate: null,
    appId: null,
    secret: `secret-${id}`,
    eventTriggers: ["RECORDING_TRANSCRIPTION_GENERATED"],
    version: "2021-10-20",
  } as WebhookSubscriber;
}

function buildBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    eventTypeId: 11,
    status: "ACCEPTED",
    metadata: null,
    eventType: { id: 11 },
    ...overrides,
  };
}

function buildMeeting(
  overrides: Partial<NotetakerMeetingForWebhookRecord> = {}
): NotetakerMeetingForWebhookRecord {
  return {
    booking: {
      id: 7,
      uid: "meeting-uid",
      title: "Customer call",
      startTime: new Date("2026-11-04T10:00:00.000Z"),
      endTime: new Date("2026-11-04T10:30:00.000Z"),
      status: "ACCEPTED",
      location: "https://meet.google.com/abc-defg-hij",
      metadata: { notetakerAdHoc: "true" },
    },
    owner: { name: "Olivia Owner", email: "owner@example.com", timeZone: "Europe/Warsaw", locale: "pl" },
    contacts: [{ email: "customer@client.example", name: "Casey Customer" }],
    ...overrides,
  };
}

function setup(booking: unknown, meeting: NotetakerMeetingForWebhookRecord | null = null) {
  const bookingRepository = { getBookingForCalEventBuilder: vi.fn().mockResolvedValue(booking) };
  const bookingNotetakerRepository = { findMeetingForWebhook: vi.fn().mockResolvedValue(meeting) };
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const gateway = new CalcomNotetakerTranscriptWebhookGateway({
    bookingRepository: bookingRepository as never,
    bookingNotetakerRepository,
    logger,
  });
  return { gateway, bookingRepository, bookingNotetakerRepository, logger };
}

describe("CalcomNotetakerTranscriptWebhookGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockReturnValue({ uid: "booking-uid", location: "integrations:daily" });
    fromBookingMock.mockResolvedValue({ build: buildMock });
  });

  it("queries subscribers for the user only", async () => {
    const { gateway } = setup(null);
    getWebhooksMock.mockResolvedValue([buildSubscriber("a")]);

    const result = await gateway.findSubscribers({ userId: 5 });

    expect(result).toHaveLength(1);
    expect(getWebhooksMock).toHaveBeenCalledWith({
      userId: 5,
      eventTypeId: null,
      teamId: null,
      orgId: null,
      oAuthClientId: null,
      triggerEvent: "RECORDING_TRANSCRIPTION_GENERATED",
    });
  });

  it("passes the member sharing teams through to the subscriber query", async () => {
    const { gateway } = setup(null);
    getWebhooksMock.mockResolvedValue([buildSubscriber("a"), buildSubscriber("team")]);

    const result = await gateway.findSubscribers({ userId: 5, memberSharingTeamIds: [20] });

    expect(result).toHaveLength(2);
    expect(getWebhooksMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, teamId: null, orgId: null, memberSharingTeamIds: [20] })
    );
  });

  it("returns null when the booking has no event type", async () => {
    const { gateway } = setup(buildBooking({ eventType: null }));

    const payload = await gateway.buildBookingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(payload).toBeNull();
    expect(fromBookingMock).not.toHaveBeenCalled();
  });

  it("returns null and logs ids only when the builder throws", async () => {
    const { gateway, logger } = setup(buildBooking());
    fromBookingMock.mockRejectedValue(new Error("boom"));

    const payload = await gateway.buildBookingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(payload).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ bookingId: 7 }));
  });

  it("adds booking fields and prefers the calendar event video url", async () => {
    const { gateway } = setup(buildBooking({ metadata: { videoCallUrl: "https://meta.example/room" } }));
    buildMock.mockReturnValue({
      uid: "booking-uid",
      location: "integrations:daily",
      videoCallData: { type: "x", url: "https://evt.example/room" },
    });

    const payload = await gateway.buildBookingPayload({
      bookingId: 7,
      fallbackVideoCallUrl: "https://fallback.example/room",
    });

    expect(payload).toMatchObject({
      bookingId: 7,
      eventTypeId: 11,
      status: "ACCEPTED",
      metadata: { videoCallUrl: "https://evt.example/room" },
      location: "https://evt.example/room",
      source: "booking",
    });
  });

  it("falls back to booking metadata, then to the session meeting url", async () => {
    const withMetadata = setup(buildBooking({ metadata: { videoCallUrl: "https://meta.example/room" } }));
    const fromMetadata = await withMetadata.gateway.buildBookingPayload({
      bookingId: 7,
      fallbackVideoCallUrl: "https://fallback.example/room",
    });
    expect(fromMetadata?.metadata).toEqual({ videoCallUrl: "https://meta.example/room" });

    const withoutMetadata = setup(buildBooking());
    const fromFallback = await withoutMetadata.gateway.buildBookingPayload({
      bookingId: 7,
      fallbackVideoCallUrl: "https://fallback.example/room",
    });
    expect(fromFallback?.metadata).toEqual({ videoCallUrl: "https://fallback.example/room" });
    expect(fromFallback?.location).toBe("https://fallback.example/room");
  });

  it("keeps the event location when no video url is known", async () => {
    const { gateway } = setup(buildBooking());

    const payload = await gateway.buildBookingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(payload?.metadata).toBeUndefined();
    expect(payload?.location).toBe("integrations:daily");
  });

  it("builds the meeting payload of an ad-hoc booking with its contacts", async () => {
    const { gateway, bookingNotetakerRepository } = setup(null, buildMeeting());

    const payload = await gateway.buildMeetingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(bookingNotetakerRepository.findMeetingForWebhook).toHaveBeenCalledWith(7);
    expect(fromBookingMock).not.toHaveBeenCalled();
    expect(payload).toEqual({
      type: "notetaker_meeting",
      uid: "meeting-uid",
      bookingId: 7,
      eventTypeId: null,
      status: "ACCEPTED",
      title: "Customer call",
      startTime: "2026-11-04T10:00:00.000Z",
      endTime: "2026-11-04T10:30:00.000Z",
      organizer: {
        name: "Olivia Owner",
        email: "owner@example.com",
        timeZone: "Europe/Warsaw",
        language: { locale: "pl" },
      },
      attendees: [
        {
          name: "Casey Customer",
          email: "customer@client.example",
          timeZone: "Europe/Warsaw",
          language: { locale: "pl" },
        },
      ],
      location: "https://meet.google.com/abc-defg-hij",
      metadata: { videoCallUrl: "https://meet.google.com/abc-defg-hij" },
      source: "ad_hoc",
    });
  });

  it("marks a calendar auto-join meeting and falls back to the session meeting url", async () => {
    const meeting = buildMeeting();
    const { gateway } = setup(
      null,
      buildMeeting({
        booking: { ...meeting.booking, location: null, metadata: { notetakerCalendarMeeting: "true" } },
      })
    );

    const payload = await gateway.buildMeetingPayload({
      bookingId: 7,
      fallbackVideoCallUrl: "https://fallback.example/room",
    });

    expect(payload).toMatchObject({
      source: "calendar_auto_join",
      location: "https://fallback.example/room",
      metadata: { videoCallUrl: "https://fallback.example/room" },
    });
  });

  it("builds the meeting payload with no attendees when the meeting has no contacts", async () => {
    const { gateway } = setup(null, buildMeeting({ contacts: [] }));

    const payload = await gateway.buildMeetingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(payload?.attendees).toEqual([]);
  });

  it("returns null and logs ids only when the meeting has no owner", async () => {
    const { gateway, logger } = setup(null, buildMeeting({ owner: null }));

    const payload = await gateway.buildMeetingPayload({ bookingId: 7, fallbackVideoCallUrl: null });

    expect(payload).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { bookingId: 7 });
  });

  it("returns null when the meeting booking is missing or the lookup throws", async () => {
    const missing = setup(null, null);
    expect(
      await missing.gateway.buildMeetingPayload({ bookingId: 7, fallbackVideoCallUrl: null })
    ).toBeNull();

    const failing = setup(null);
    failing.bookingNotetakerRepository.findMeetingForWebhook.mockRejectedValue(new Error("db down"));
    expect(
      await failing.gateway.buildMeetingPayload({ bookingId: 7, fallbackVideoCallUrl: null })
    ).toBeNull();
    expect(failing.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ bookingId: 7 })
    );
  });

  it("delivers to every subscriber with a shared createdAt and survives a failure", async () => {
    const { gateway, logger } = setup(null);
    const subscribers = [buildSubscriber("a"), buildSubscriber("b"), buildSubscriber("c")];
    const payload = { uid: "booking-uid" } as EventPayloadType;
    sendOrSchedulePayloadMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(undefined);

    const result = await gateway.deliver({ subscribers, createdAt: "2026-11-04T10:00:00.000Z", payload });

    expect(result).toEqual({ attempted: 3, failed: 1 });
    expect(sendOrSchedulePayloadMock).toHaveBeenCalledTimes(3);
    for (const [index, subscriber] of subscribers.entries()) {
      expect(sendOrSchedulePayloadMock).toHaveBeenNthCalledWith(
        index + 1,
        subscriber.secret,
        "RECORDING_TRANSCRIPTION_GENERATED",
        "2026-11-04T10:00:00.000Z",
        subscriber,
        payload
      );
    }
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
