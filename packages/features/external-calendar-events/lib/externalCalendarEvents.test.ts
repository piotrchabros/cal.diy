import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CalDiyMatchSets,
  type CalendarEventEntry,
  findSupportedMeetingLink,
  isRepresentedInCalDiy,
  mapWithConcurrency,
  selectVisibleEntries,
  toExternalCalendarEventDto,
  withTimeout,
} from "./externalCalendarEvents";

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const TEAMS_URL = "https://teams.microsoft.com/meet/123456789012?p=abc123";

function makeEntry(
  event: Partial<NotetakerCalendarEvent> = {},
  calendar: Partial<CalendarEventEntry["calendar"]> = {}
): CalendarEventEntry {
  return {
    calendar: {
      selectedCalendarId: "cal-1",
      integration: "google_calendar",
      externalId: "primary",
      credentialId: 1,
      delegationCredentialId: null,
      ...calendar,
    },
    event: {
      externalId: "ev-1",
      iCalUID: "uid-1@google.com",
      recurringEventId: null,
      title: "Standup",
      start: new Date("2026-11-05T10:00:00Z"),
      end: new Date("2026-11-05T11:00:00Z"),
      isAllDay: false,
      status: "confirmed",
      selfResponse: "accepted",
      organizerEmail: null,
      attendeeEmails: ["a@x.com", "b@x.com"],
      candidateLinks: [],
      ...event,
    },
  };
}

function emptySets(overrides: Partial<CalDiyMatchSets> = {}): CalDiyMatchSets {
  return {
    iCalUIDs: new Set(),
    referenceUids: new Set(),
    participantEventKeys: new Set(),
    bookedLocations: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("selectVisibleEntries", () => {
  it("drops cancelled and declined events", () => {
    const entries = [
      makeEntry({ externalId: "a", iCalUID: "a" }),
      makeEntry({ externalId: "b", iCalUID: "b", status: "cancelled" }),
      makeEntry({ externalId: "c", iCalUID: "c", selfResponse: "declined" }),
      makeEntry({ externalId: "d", iCalUID: "d", status: "tentative", selfResponse: "needsAction" }),
    ];
    expect(selectVisibleEntries(entries).map((e) => e.event.externalId)).toEqual(["a", "d"]);
  });

  it("dedupes the same event across calendars by iCalUID and start, keeping the first", () => {
    const first = makeEntry({ externalId: "x1" }, { selectedCalendarId: "cal-1" });
    const second = makeEntry({ externalId: "x2" }, { selectedCalendarId: "cal-2" });
    const result = selectVisibleEntries([first, second]);
    expect(result).toEqual([first]);
  });

  it("falls back to externalId when iCalUID is missing", () => {
    const first = makeEntry({ iCalUID: null, externalId: "same" }, { selectedCalendarId: "cal-1" });
    const second = makeEntry({ iCalUID: null, externalId: "same" }, { selectedCalendarId: "cal-2" });
    const other = makeEntry({ iCalUID: null, externalId: "other" }, { selectedCalendarId: "cal-2" });
    expect(selectVisibleEntries([first, second, other])).toEqual([first, other]);
  });

  it("keeps instances of the same series that start at different times", () => {
    const a = makeEntry({ externalId: "i1" });
    const b = makeEntry({ externalId: "i2", start: new Date("2026-11-06T10:00:00Z") });
    expect(selectVisibleEntries([a, b])).toHaveLength(2);
  });
});

describe("findSupportedMeetingLink", () => {
  it("returns null when no link is a supported platform", () => {
    expect(findSupportedMeetingLink(["https://zoom.us/j/123456789", "not a url"])).toBeNull();
    expect(findSupportedMeetingLink([])).toBeNull();
  });

  it("finds Google Meet and Teams links", () => {
    expect(findSupportedMeetingLink([MEET_URL])).toEqual({ meetingUrl: MEET_URL, platform: "GOOGLE_MEET" });
    expect(findSupportedMeetingLink([TEAMS_URL])).toEqual({
      meetingUrl: TEAMS_URL,
      platform: "MICROSOFT_TEAMS",
    });
  });

  it("uses the first supported link in order", () => {
    const result = findSupportedMeetingLink(["https://zoom.us/j/1", TEAMS_URL, MEET_URL]);
    expect(result?.platform).toBe("MICROSOFT_TEAMS");
  });
});

describe("isRepresentedInCalDiy", () => {
  it("matches by iCalUID", () => {
    expect(
      isRepresentedInCalDiy(makeEntry(), null, emptySets({ iCalUIDs: new Set(["uid-1@google.com"]) }))
    ).toBe(true);
  });

  it("ignores an empty iCalUID", () => {
    expect(
      isRepresentedInCalDiy(makeEntry({ iCalUID: "" }), null, emptySets({ iCalUIDs: new Set([""]) }))
    ).toBe(false);
  });

  it("matches by externalId or recurringEventId reference uid", () => {
    expect(isRepresentedInCalDiy(makeEntry(), null, emptySets({ referenceUids: new Set(["ev-1"]) }))).toBe(
      true
    );
    expect(
      isRepresentedInCalDiy(
        makeEntry({ recurringEventId: "series-1" }),
        null,
        emptySets({ referenceUids: new Set(["series-1"]) })
      )
    ).toBe(true);
  });

  it("matches by participant event key", () => {
    expect(
      isRepresentedInCalDiy(makeEntry(), null, emptySets({ participantEventKeys: new Set(["cal-1:ev-1"]) }))
    ).toBe(true);
    expect(
      isRepresentedInCalDiy(makeEntry(), null, emptySets({ participantEventKeys: new Set(["cal-2:ev-1"]) }))
    ).toBe(false);
  });

  describe("booked location overlap", () => {
    const booked = (start: string, end: string) =>
      emptySets({
        bookedLocations: [{ location: MEET_URL, startTime: new Date(start), endTime: new Date(end) }],
      });

    it("matches when location equals and times overlap", () => {
      expect(
        isRepresentedInCalDiy(makeEntry(), MEET_URL, booked("2026-11-05T10:30:00Z", "2026-11-05T11:30:00Z"))
      ).toBe(true);
    });

    it("does not match when the booking only touches the event end", () => {
      expect(
        isRepresentedInCalDiy(makeEntry(), MEET_URL, booked("2026-11-05T11:00:00Z", "2026-11-05T12:00:00Z"))
      ).toBe(false);
    });

    it("does not match when the booking only touches the event start", () => {
      expect(
        isRepresentedInCalDiy(makeEntry(), MEET_URL, booked("2026-11-05T09:00:00Z", "2026-11-05T10:00:00Z"))
      ).toBe(false);
    });

    it("does not match a different location or a missing meeting url", () => {
      const sets = booked("2026-11-05T10:30:00Z", "2026-11-05T11:30:00Z");
      expect(isRepresentedInCalDiy(makeEntry(), TEAMS_URL, sets)).toBe(false);
      expect(isRepresentedInCalDiy(makeEntry(), null, sets)).toBe(false);
    });
  });
});

describe("toExternalCalendarEventDto", () => {
  it("maps fields without leaking attendee emails", () => {
    const dto = toExternalCalendarEventDto(makeEntry({ status: "tentative", selfResponse: "needsAction" }), {
      meetingUrl: MEET_URL,
      platform: "GOOGLE_MEET",
    });
    expect(dto).toEqual({
      key: "cal-1:ev-1",
      title: "Standup",
      start: new Date("2026-11-05T10:00:00Z"),
      end: new Date("2026-11-05T11:00:00Z"),
      isAllDay: false,
      status: "tentative",
      selfResponse: "needsAction",
      attendeesCount: 2,
      meetingUrl: MEET_URL,
      meetingPlatform: "GOOGLE_MEET",
      calendar: { selectedCalendarId: "cal-1", integration: "google_calendar", externalId: "primary" },
    });
  });

  it("has no meeting fields without a link", () => {
    const dto = toExternalCalendarEventDto(makeEntry(), null);
    expect(dto.meetingUrl).toBeNull();
    expect(dto.meetingPlatform).toBeNull();
    expect(dto.status).toBe("confirmed");
  });
});

describe("withTimeout", () => {
  it("rejects with a labelled error after the timeout", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(new Promise<string>(() => {}), 8000, "google_calendar cal-1");
    const assertion = expect(promise).rejects.toThrow("google_calendar cal-1 timed out after 8000ms");
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
  });

  it("resolves and clears the timer when the promise settles first", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("ok"), 1000, "x")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("mapWithConcurrency", () => {
  it("respects the limit and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, (8 - n) * 2));
      active -= 1;
      return n * 10;
    });
    expect(maxActive).toBe(3);
    expect(results).toEqual(items.map((n) => ({ status: "fulfilled", value: n * 10 })));
  });

  it("reports failures as rejected without stopping other items", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toEqual(new Error("boom"));
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
