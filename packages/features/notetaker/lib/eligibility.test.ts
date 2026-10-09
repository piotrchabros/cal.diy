import { DailyLocationType, MeetLocationType, MSTeamsLocationType } from "@calcom/app-store/constants";
import { describe, expect, it } from "vitest";
import {
  classifyMeetingUrl,
  getBookingNotetakerEligibility,
  getEventTypeNotetakerAvailability,
  resolveMeetingLink,
} from "./eligibility";

const GOOGLE_MEET_REFERENCE = "google_meet_video";
const OFFICE365_VIDEO_REFERENCE = "office365_video";
const OFFICE365_CALENDAR_REFERENCE = "office365_calendar";
const DAILY_REFERENCE = "daily_video";

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const TEAMS_URL = "https://teams.microsoft.com/l/meetup-join/x";

type BookingInput = Parameters<typeof getBookingNotetakerEligibility>[0];

function booking(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    location: null,
    metadata: null,
    references: [],
    bookingStatus: "ACCEPTED",
    enabledPlatforms: ["GOOGLE_MEET"],
    ...overrides,
  };
}

describe("resolveMeetingLink", () => {
  it("prefers metadata.videoCallUrl over references and location", () => {
    expect(
      resolveMeetingLink({
        location: "https://example.com/loc",
        metadata: { videoCallUrl: MEET_URL },
        references: [{ type: GOOGLE_MEET_REFERENCE, meetingUrl: "https://meet.google.com/ref-ref-ref" }],
      })
    ).toBe(MEET_URL);
  });

  it("falls back to a google_meet_video reference when metadata has no videoCallUrl", () => {
    expect(
      resolveMeetingLink({
        location: null,
        metadata: {},
        references: [{ type: GOOGLE_MEET_REFERENCE, meetingUrl: MEET_URL }],
      })
    ).toBe(MEET_URL);
  });

  it.each([
    OFFICE365_VIDEO_REFERENCE,
    OFFICE365_CALENDAR_REFERENCE,
  ])("falls back to a %s reference", (type) => {
    expect(
      resolveMeetingLink({ location: null, metadata: null, references: [{ type, meetingUrl: TEAMS_URL }] })
    ).toBe(TEAMS_URL);
  });

  it("ignores a deleted reference and uses the next non-deleted one", () => {
    expect(
      resolveMeetingLink({
        location: null,
        metadata: null,
        references: [
          { type: GOOGLE_MEET_REFERENCE, meetingUrl: "https://meet.google.com/old-old-old", deleted: true },
          { type: GOOGLE_MEET_REFERENCE, meetingUrl: MEET_URL, deleted: false },
        ],
      })
    ).toBe(MEET_URL);
  });

  it("ignores references with a null meetingUrl and references of other types", () => {
    expect(
      resolveMeetingLink({
        location: null,
        metadata: null,
        references: [
          { type: GOOGLE_MEET_REFERENCE, meetingUrl: null },
          { type: DAILY_REFERENCE, meetingUrl: "https://app.example.com/video/abc" },
          { type: "zoom_video", meetingUrl: "https://zoom.us/j/1" },
        ],
      })
    ).toBeNull();
  });

  it("falls back to location when it starts with http", () => {
    expect(resolveMeetingLink({ location: MEET_URL, metadata: null, references: [] })).toBe(MEET_URL);
  });

  it.each([
    MeetLocationType,
    "123 Main St",
    null,
  ])("returns null when location is %s and nothing else resolves", (location) => {
    expect(resolveMeetingLink({ location, metadata: null, references: [] })).toBeNull();
  });

  it.each([
    null,
    "https://meet.google.com/x",
    [MEET_URL],
    { videoCallUrl: 123 },
    { videoCallUrl: "" },
  ])("tolerates odd metadata %j", (metadata) => {
    expect(resolveMeetingLink({ location: null, metadata, references: [] })).toBeNull();
  });
});

describe("classifyMeetingUrl", () => {
  it("classifies Google Meet", () => {
    expect(classifyMeetingUrl(MEET_URL)).toBe("GOOGLE_MEET");
  });

  it.each([TEAMS_URL, "https://teams.live.com/meet/123"])("classifies %s as Teams", (url) => {
    expect(classifyMeetingUrl(url)).toBe("MICROSOFT_TEAMS");
  });

  it("matches the host case-insensitively", () => {
    expect(classifyMeetingUrl("https://MEET.GOOGLE.COM/x")).toBe("GOOGLE_MEET");
  });

  it.each([
    "https://zoom.us/j/1",
    "https://meet.google.com.evil.com/x",
    "https://notmeet.google.com/x",
  ])("returns null for %s", (url) => {
    expect(classifyMeetingUrl(url)).toBeNull();
  });

  it.each([
    "not a url",
    "",
    "meet.google.com/abc",
    "ftp://meet.google.com/x",
  ])("returns null for malformed input %j", (url) => {
    expect(classifyMeetingUrl(url)).toBeNull();
  });
});

describe("getBookingNotetakerEligibility", () => {
  it("is eligible with a Meet URL in metadata.videoCallUrl", () => {
    expect(getBookingNotetakerEligibility(booking({ metadata: { videoCallUrl: MEET_URL } }))).toEqual({
      eligible: true,
      platform: "GOOGLE_MEET",
      reason: null,
    });
  });

  it("is eligible with a Meet URL only through a google_meet_video reference", () => {
    const result = getBookingNotetakerEligibility(
      booking({ references: [{ type: GOOGLE_MEET_REFERENCE, meetingUrl: MEET_URL }] })
    );
    expect(result).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
  });

  it("is eligible with a pasted Meet link as location", () => {
    expect(getBookingNotetakerEligibility(booking({ location: MEET_URL })).eligible).toBe(true);
  });

  it("is provisionally eligible for a pending Meet booking without a link", () => {
    expect(
      getBookingNotetakerEligibility(booking({ location: MeetLocationType, bookingStatus: "PENDING" }))
    ).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
  });

  it("is provisionally eligible for an AWAITING_HOST Meet booking without a link", () => {
    expect(
      getBookingNotetakerEligibility(booking({ location: MeetLocationType, bookingStatus: "AWAITING_HOST" }))
    ).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
  });

  it("is provisionally eligible for a pending Teams booking when Teams is enabled", () => {
    expect(
      getBookingNotetakerEligibility(
        booking({
          location: MSTeamsLocationType,
          bookingStatus: "PENDING",
          enabledPlatforms: ["GOOGLE_MEET", "MICROSOFT_TEAMS"],
        })
      )
    ).toEqual({ eligible: true, platform: "MICROSOFT_TEAMS", reason: null });
  });

  it("reports NO_MEETING_LINK with the platform for an accepted Meet booking without a link", () => {
    expect(getBookingNotetakerEligibility(booking({ location: MeetLocationType }))).toEqual({
      eligible: false,
      platform: "GOOGLE_MEET",
      reason: "NO_MEETING_LINK",
    });
  });

  it("reports CAL_VIDEO for the Cal Video location type", () => {
    expect(getBookingNotetakerEligibility(booking({ location: DailyLocationType }))).toEqual({
      eligible: false,
      platform: null,
      reason: "CAL_VIDEO",
    });
  });

  it("reports CAL_VIDEO when a Meet location fell back to a daily_video reference", () => {
    const result = getBookingNotetakerEligibility(
      booking({
        location: MeetLocationType,
        references: [{ type: DAILY_REFERENCE, meetingUrl: "https://app.example.com/video/abc123" }],
      })
    );
    expect(result.reason).toBe("CAL_VIDEO");
    expect(result.eligible).toBe(false);
  });

  it("reports CAL_VIDEO for a Cal Video URL even when the location says Meet", () => {
    const result = getBookingNotetakerEligibility(
      booking({
        location: MeetLocationType,
        metadata: { videoCallUrl: "https://app.example.com/video/abc123" },
      })
    );
    expect(result).toEqual({ eligible: false, platform: null, reason: "CAL_VIDEO" });
  });

  it("reports CAL_VIDEO for a daily.co URL", () => {
    const result = getBookingNotetakerEligibility(
      booking({ metadata: { videoCallUrl: "https://cal.daily.co/room" } })
    );
    expect(result.reason).toBe("CAL_VIDEO");
  });

  it("does not treat a deleted daily_video reference as Cal Video", () => {
    const result = getBookingNotetakerEligibility(
      booking({
        metadata: { videoCallUrl: MEET_URL },
        references: [
          { type: DAILY_REFERENCE, meetingUrl: "https://app.example.com/video/abc", deleted: true },
        ],
      })
    );
    expect(result).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
  });

  it.each(["123 Main St", "+48123456789"])("reports IN_PERSON_OR_PHONE for location %s", (location) => {
    expect(getBookingNotetakerEligibility(booking({ location }))).toEqual({
      eligible: false,
      platform: null,
      reason: "IN_PERSON_OR_PHONE",
    });
  });

  it("reports UNSUPPORTED_PLATFORM for another meeting URL", () => {
    expect(getBookingNotetakerEligibility(booking({ location: "https://zoom.us/j/1" }))).toEqual({
      eligible: false,
      platform: null,
      reason: "UNSUPPORTED_PLATFORM",
    });
  });

  it("reports UNSUPPORTED_PLATFORM for another integration type without a link", () => {
    expect(getBookingNotetakerEligibility(booking({ location: "integrations:zoom" }))).toEqual({
      eligible: false,
      platform: null,
      reason: "UNSUPPORTED_PLATFORM",
    });
  });

  it("reports UNSUPPORTED_PLATFORM for a null location without a link", () => {
    expect(getBookingNotetakerEligibility(booking())).toEqual({
      eligible: false,
      platform: null,
      reason: "UNSUPPORTED_PLATFORM",
    });
  });

  it("reports UNSUPPORTED_PLATFORM with the platform for a Teams URL when Teams is not enabled", () => {
    expect(getBookingNotetakerEligibility(booking({ metadata: { videoCallUrl: TEAMS_URL } }))).toEqual({
      eligible: false,
      platform: "MICROSOFT_TEAMS",
      reason: "UNSUPPORTED_PLATFORM",
    });
  });

  it("is eligible for a Teams URL when Teams is enabled", () => {
    expect(
      getBookingNotetakerEligibility(
        booking({ metadata: { videoCallUrl: TEAMS_URL }, enabledPlatforms: ["MICROSOFT_TEAMS"] })
      )
    ).toEqual({ eligible: true, platform: "MICROSOFT_TEAMS", reason: null });
  });

  it("reports UNSUPPORTED_PLATFORM for a pending Teams location without a link when Teams is not enabled", () => {
    expect(
      getBookingNotetakerEligibility(booking({ location: MSTeamsLocationType, bookingStatus: "PENDING" }))
    ).toEqual({ eligible: false, platform: "MICROSOFT_TEAMS", reason: "UNSUPPORTED_PLATFORM" });
  });

  it("reports UNSUPPORTED_PLATFORM with the platform for a Meet URL when only Teams is enabled", () => {
    expect(
      getBookingNotetakerEligibility(
        booking({ metadata: { videoCallUrl: MEET_URL }, enabledPlatforms: ["MICROSOFT_TEAMS"] })
      )
    ).toEqual({ eligible: false, platform: "GOOGLE_MEET", reason: "UNSUPPORTED_PLATFORM" });
  });

  it.each([
    "CANCELLED",
    "REJECTED",
  ] as const)("reports BOOKING_NOT_ACTIVE for a %s booking with a valid Meet URL", (bookingStatus) => {
    expect(
      getBookingNotetakerEligibility(booking({ bookingStatus, metadata: { videoCallUrl: MEET_URL } }))
    ).toEqual({ eligible: false, platform: null, reason: "BOOKING_NOT_ACTIVE" });
  });
});

describe("getEventTypeNotetakerAvailability", () => {
  const enabled = ["GOOGLE_MEET"] as const;
  const both = ["GOOGLE_MEET", "MICROSOFT_TEAMS"] as const;

  it("is available with a Meet location", () => {
    expect(
      getEventTypeNotetakerAvailability({
        locations: [{ type: MeetLocationType }],
        enabledPlatforms: [...enabled],
      })
    ).toEqual({ available: true, unavailableReason: null, supportedLocationTypes: [MeetLocationType] });
  });

  it("lists only supported types among mixed locations", () => {
    const result = getEventTypeNotetakerAvailability({
      locations: [{ type: "inPerson" }, { type: MeetLocationType }, { type: DailyLocationType }],
      enabledPlatforms: [...enabled],
    });
    expect(result.available).toBe(true);
    expect(result.supportedLocationTypes).toEqual([MeetLocationType]);
  });

  it("keeps order and collapses duplicates when both platforms are enabled", () => {
    const result = getEventTypeNotetakerAvailability({
      locations: [{ type: MSTeamsLocationType }, { type: MeetLocationType }, { type: MSTeamsLocationType }],
      enabledPlatforms: [...both],
    });
    expect(result.supportedLocationTypes).toEqual([MSTeamsLocationType, MeetLocationType]);
  });

  it("is unavailable for a Teams location when Teams is not enabled", () => {
    expect(
      getEventTypeNotetakerAvailability({
        locations: [{ type: MSTeamsLocationType }],
        enabledPlatforms: [...enabled],
      })
    ).toEqual({ available: false, unavailableReason: "UNSUPPORTED_PLATFORM", supportedLocationTypes: [] });
  });

  it("drops Teams but stays available with Meet when Teams is not enabled", () => {
    const result = getEventTypeNotetakerAvailability({
      locations: [{ type: MeetLocationType }, { type: MSTeamsLocationType }],
      enabledPlatforms: [...enabled],
    });
    expect(result.available).toBe(true);
    expect(result.supportedLocationTypes).toEqual([MeetLocationType]);
  });

  it.each([
    [[{ type: DailyLocationType }]],
    [[{ type: DailyLocationType }, { type: DailyLocationType }]],
  ])("reports CAL_VIDEO when every location is Cal Video (%j)", (locations) => {
    expect(getEventTypeNotetakerAvailability({ locations, enabledPlatforms: [...enabled] })).toEqual({
      available: false,
      unavailableReason: "CAL_VIDEO",
      supportedLocationTypes: [],
    });
  });

  it("reports UNSUPPORTED_PLATFORM when Cal Video is mixed with another location", () => {
    const result = getEventTypeNotetakerAvailability({
      locations: [{ type: DailyLocationType }, { type: "inPerson" }],
      enabledPlatforms: [...enabled],
    });
    expect(result.unavailableReason).toBe("UNSUPPORTED_PLATFORM");
  });

  it.each([
    [[{ type: "inPerson" }, { type: "phone" }]],
    [[{ type: "link" }]],
    [[{ type: "conferencing" }]],
  ])("reports UNSUPPORTED_PLATFORM for %j", (locations) => {
    expect(getEventTypeNotetakerAvailability({ locations, enabledPlatforms: [...enabled] })).toEqual({
      available: false,
      unavailableReason: "UNSUPPORTED_PLATFORM",
      supportedLocationTypes: [],
    });
  });

  it("reports CAL_VIDEO for an event type without locations", () => {
    expect(getEventTypeNotetakerAvailability({ locations: [], enabledPlatforms: [...enabled] })).toEqual({
      available: false,
      unavailableReason: "CAL_VIDEO",
      supportedLocationTypes: [],
    });
  });
});
