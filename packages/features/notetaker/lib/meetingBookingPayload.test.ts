import { describe, expect, it } from "vitest";
import { buildNotetakerMeetingBookingPayload, resolveNotetakerBookingSource } from "./meetingBookingPayload";

const baseInput = {
  booking: {
    id: 7,
    uid: "uid-7",
    title: "Sync",
    startTime: new Date("2026-11-05T10:00:00.000Z"),
    endTime: new Date("2026-11-05T11:00:00.000Z"),
    status: "ACCEPTED",
    location: "https://meet.google.com/abc-defg-hij",
    metadata: { notetakerAdHoc: "true" } as unknown,
  },
  owner: { name: null, email: "owner@example.com", timeZone: "Europe/Warsaw", locale: null },
  contacts: [
    { email: "a@example.com", name: null },
    { email: "b@example.com", name: "Bee" },
  ],
  fallbackVideoCallUrl: null,
};

describe("resolveNotetakerBookingSource", () => {
  it("detects ad hoc, calendar auto-join and regular bookings", () => {
    expect(resolveNotetakerBookingSource({ notetakerAdHoc: "true" })).toBe("ad_hoc");
    expect(resolveNotetakerBookingSource({ notetakerCalendarMeeting: "true" })).toBe("calendar_auto_join");
    expect(resolveNotetakerBookingSource({})).toBe("booking");
    expect(resolveNotetakerBookingSource(null)).toBe("booking");
  });
});

describe("buildNotetakerMeetingBookingPayload", () => {
  it("builds an ad hoc payload", () => {
    const payload = buildNotetakerMeetingBookingPayload(baseInput);
    expect(payload).toMatchObject({
      type: "notetaker_meeting",
      eventTypeId: null,
      source: "ad_hoc",
      startTime: "2026-11-05T10:00:00.000Z",
      endTime: "2026-11-05T11:00:00.000Z",
      location: "https://meet.google.com/abc-defg-hij",
      metadata: { videoCallUrl: "https://meet.google.com/abc-defg-hij" },
      organizer: {
        name: "owner@example.com",
        email: "owner@example.com",
        timeZone: "Europe/Warsaw",
        language: { locale: "en" },
      },
    });
    expect(payload.attendees).toEqual([
      { name: "", email: "a@example.com", timeZone: "Europe/Warsaw", language: { locale: "en" } },
      { name: "Bee", email: "b@example.com", timeZone: "Europe/Warsaw", language: { locale: "en" } },
    ]);
  });

  it("marks calendar auto-join bookings", () => {
    const payload = buildNotetakerMeetingBookingPayload({
      ...baseInput,
      booking: { ...baseInput.booking, metadata: { notetakerCalendarMeeting: "true" } },
    });
    expect(payload.source).toBe("calendar_auto_join");
  });

  it("falls back to ad hoc when metadata carries no marker", () => {
    const payload = buildNotetakerMeetingBookingPayload({
      ...baseInput,
      booking: { ...baseInput.booking, metadata: null },
    });
    expect(payload.source).toBe("ad_hoc");
  });

  it("returns no attendees without contacts", () => {
    expect(buildNotetakerMeetingBookingPayload({ ...baseInput, contacts: [] }).attendees).toEqual([]);
  });

  it("omits metadata without a URL and uses the fallback URL when location is empty", () => {
    const noUrl = buildNotetakerMeetingBookingPayload({
      ...baseInput,
      booking: { ...baseInput.booking, location: null },
    });
    expect(noUrl.metadata).toBeUndefined();
    expect(noUrl.location).toBeNull();

    const withFallback = buildNotetakerMeetingBookingPayload({
      ...baseInput,
      booking: { ...baseInput.booking, location: null },
      fallbackVideoCallUrl: "https://meet.google.com/zzz-zzzz-zzz",
    });
    expect(withFallback.metadata).toEqual({ videoCallUrl: "https://meet.google.com/zzz-zzzz-zzz" });
    expect(withFallback.location).toBe("https://meet.google.com/zzz-zzzz-zzz");
  });
});
