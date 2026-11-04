import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { describe, expect, it } from "vitest";
import {
  buildMeetingKey,
  decideCalendarEvent,
  extractMeetingLinksFromText,
  isCalendarMeetingBookingMetadata,
  NOTETAKER_CALENDAR_MEETING_KEY,
  type NotetakerCalendarEvent,
} from "./calendarMeeting";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const BOTH: NotetakerPlatformDto[] = ["GOOGLE_MEET", "MICROSOFT_TEAMS"];
const SELF = ["Me@Example.com"];
const MEET = "https://meet.google.com/abc-defg-hij";
const THREAD = "19:meeting_NjU5YTk2ZDUtYzJmMS00ZjQ5LWE4YzEtNjZhYmY2YTQ5ZWNh@thread.v2";
const CONTEXT = '{"Tid":"72f988bf-86f1-41af-91ab-2d7cd011db47","Oid":"4b8a1c2e-0000-4000-8000-000000000001"}';
const TEAMS = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(THREAD)}/0?context=${encodeURIComponent(CONTEXT)}`;

const buildEvent = (overrides: Partial<NotetakerCalendarEvent> = {}): NotetakerCalendarEvent => ({
  externalId: "evt-1",
  iCalUID: "evt-1@google.com",
  recurringEventId: null,
  title: "Sync",
  start: new Date("2026-11-04T11:00:00.000Z"),
  end: new Date("2026-11-04T12:00:00.000Z"),
  isAllDay: false,
  status: "confirmed",
  selfResponse: "accepted",
  organizerEmail: "boss@example.com",
  attendeeEmails: ["me@example.com", "other@example.com"],
  candidateLinks: [MEET],
  ...overrides,
});

const decide = (event: NotetakerCalendarEvent, enabledPlatforms: NotetakerPlatformDto[] = BOTH) =>
  decideCalendarEvent(event, { now: NOW, enabledPlatforms, selfEmails: SELF });
const skipped = (reason: string) => ({ join: false, reason });

describe("decideCalendarEvent", () => {
  it("joins an accepted Meet event with a canonical url and key", () => {
    expect(
      decide(buildEvent({ candidateLinks: ["https://meet.google.com/ABC-defg-hij?authuser=1"] }))
    ).toEqual({
      join: true,
      platform: "GOOGLE_MEET",
      meetingUrl: MEET,
      meetingKey: `GOOGLE_MEET:${MEET}`,
    });
  });

  it("joins a Teams event", () => {
    const decision = decide(buildEvent({ candidateLinks: [TEAMS] }));
    expect(decision).toMatchObject({ join: true, platform: "MICROSOFT_TEAMS" });
    expect(decision.join && decision.meetingKey).toBe(buildMeetingKey("MICROSOFT_TEAMS", TEAMS));
  });

  it("joins an organizer event", () => {
    expect(decide(buildEvent({ selfResponse: "organizer" }))).toMatchObject({ join: true });
  });

  it("treats a missing self response as organizer when the organizer email matches case-insensitively", () => {
    const event = buildEvent({ selfResponse: null, organizerEmail: "ME@example.COM" });
    expect(decide(event)).toMatchObject({ join: true });
  });

  it("skips a missing self response when someone else organizes", () => {
    expect(decide(buildEvent({ selfResponse: null }))).toEqual(skipped("NOT_ACCEPTED"));
    expect(decide(buildEvent({ selfResponse: null, organizerEmail: null }))).toEqual(skipped("NOT_ACCEPTED"));
  });

  it("skips cancelled events", () => {
    expect(decide(buildEvent({ status: "cancelled" }))).toEqual(skipped("CANCELLED"));
  });

  it("skips all-day events", () => {
    expect(decide(buildEvent({ isAllDay: true }))).toEqual(skipped("ALL_DAY"));
  });

  it("skips ended events, including one ending exactly now", () => {
    expect(decide(buildEvent({ end: new Date("2026-11-04T09:00:00.000Z") }))).toEqual(skipped("ENDED"));
    expect(decide(buildEvent({ end: NOW }))).toEqual(skipped("ENDED"));
  });

  it("joins an event that already started but has not ended", () => {
    expect(decide(buildEvent({ start: new Date("2026-11-04T09:30:00.000Z") }))).toMatchObject({ join: true });
  });

  it("skips declined events", () => {
    expect(decide(buildEvent({ selfResponse: "declined" }))).toEqual(skipped("DECLINED"));
  });

  it.each(["tentative", "needsAction"] as const)("skips %s events", (selfResponse) => {
    expect(decide(buildEvent({ selfResponse }))).toEqual(skipped("NOT_ACCEPTED"));
  });

  it("skips events with no attendee other than the user, ignoring email case", () => {
    expect(decide(buildEvent({ attendeeEmails: [] }))).toEqual(skipped("NO_OTHER_ATTENDEES"));
    expect(decide(buildEvent({ attendeeEmails: ["ME@EXAMPLE.COM"] }))).toEqual(skipped("NO_OTHER_ATTENDEES"));
  });

  it("skips events without any link", () => {
    expect(decide(buildEvent({ candidateLinks: [] }))).toEqual(skipped("NO_SUPPORTED_LINK"));
  });

  it("skips unsupported, invalid and wrapped links", () => {
    const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(MEET)}&data=x`;
    const event = buildEvent({ candidateLinks: ["https://zoom.us/j/123456789", "not a url", wrapped] });
    expect(decide(event)).toEqual(skipped("NO_SUPPORTED_LINK"));
  });

  it("skips a platform that is not enabled", () => {
    expect(decide(buildEvent({ candidateLinks: [TEAMS] }), ["GOOGLE_MEET"])).toEqual(
      skipped("NO_SUPPORTED_LINK")
    );
  });

  it("picks the first supported link in order, skipping unusable ones before it", () => {
    const event = buildEvent({ candidateLinks: ["https://zoom.us/j/1", TEAMS, MEET] });
    expect(decide(event)).toMatchObject({ join: true, platform: "MICROSOFT_TEAMS" });
    expect(decide(buildEvent({ candidateLinks: [MEET, TEAMS] }))).toMatchObject({ platform: "GOOGLE_MEET" });
  });

  it("reports the earliest applicable reason", () => {
    const event = buildEvent({ status: "cancelled", isAllDay: true, selfResponse: "declined" });
    expect(decide(event)).toEqual(skipped("CANCELLED"));
    expect(decide(buildEvent({ isAllDay: true, end: new Date("2026-11-04T09:00:00.000Z") }))).toEqual(
      skipped("ALL_DAY")
    );
  });
});

describe("buildMeetingKey", () => {
  it("joins platform and canonical url", () => {
    expect(buildMeetingKey("GOOGLE_MEET", MEET)).toBe(`GOOGLE_MEET:${MEET}`);
  });
});

describe("NOTETAKER_CALENDAR_MEETING_KEY", () => {
  it("is the booking metadata key", () => {
    expect(NOTETAKER_CALENDAR_MEETING_KEY).toBe("notetakerCalendarMeeting");
  });
});

describe("extractMeetingLinksFromText", () => {
  it("returns links in order of appearance without duplicates", () => {
    const text = `Join ${TEAMS} or ${MEET}. Again: ${MEET}`;
    expect(extractMeetingLinksFromText(text)).toEqual([TEAMS, MEET]);
  });

  it("strips trailing punctuation", () => {
    expect(extractMeetingLinksFromText(`(${MEET}), then ${MEET}.`)).toEqual([MEET]);
  });

  it("extracts links from HTML bodies and decodes entities", () => {
    const html = `<p>Join: <a href="https://meet.google.com/abc-defg-hij?pli=1&amp;authuser=0">click</a></p><br>&lt;https://example.com/x&gt;`;
    expect(extractMeetingLinksFromText(html)).toEqual([
      "https://meet.google.com/abc-defg-hij?pli=1&authuser=0",
      "https://example.com/x",
    ]);
  });

  it("returns nothing when there is no link", () => {
    expect(extractMeetingLinksFromText("no links here, ftp://x.y")).toEqual([]);
    expect(extractMeetingLinksFromText("")).toEqual([]);
  });

  it("feeds decideCalendarEvent end to end", () => {
    const links = extractMeetingLinksFromText(`<div>Call: <a href="${MEET}">${MEET}</a></div>`);
    expect(links).toEqual([MEET]);
    expect(decide(buildEvent({ candidateLinks: links }))).toMatchObject({ join: true });
  });
});

describe("isCalendarMeetingBookingMetadata", () => {
  it("is true only for the string marker", () => {
    expect(isCalendarMeetingBookingMetadata({ [NOTETAKER_CALENDAR_MEETING_KEY]: "true" })).toBe(true);
    expect(isCalendarMeetingBookingMetadata({ [NOTETAKER_CALENDAR_MEETING_KEY]: true })).toBe(false);
    expect(isCalendarMeetingBookingMetadata({ [NOTETAKER_CALENDAR_MEETING_KEY]: "false" })).toBe(false);
    expect(isCalendarMeetingBookingMetadata({})).toBe(false);
  });

  it("is false for metadata that is not an object", () => {
    expect(isCalendarMeetingBookingMetadata(null)).toBe(false);
    expect(isCalendarMeetingBookingMetadata("true")).toBe(false);
    expect(isCalendarMeetingBookingMetadata([NOTETAKER_CALENDAR_MEETING_KEY])).toBe(false);
  });
});
