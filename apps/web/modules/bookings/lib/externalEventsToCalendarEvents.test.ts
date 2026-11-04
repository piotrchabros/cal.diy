import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { describe, expect, it } from "vitest";
import { EXTERNAL_EVENT_ID_BASE, toWeekCalendarEvents } from "./externalEventsToCalendarEvents";

const WEEK_START = new Date("2026-11-02T00:00:00.000Z");
const WEEK_END = new Date("2026-11-09T00:00:00.000Z");

function buildEvent(overrides: Partial<ExternalCalendarEventDto> = {}): ExternalCalendarEventDto {
  return {
    key: "sc-1:evt-1",
    title: "Standup",
    start: new Date("2026-11-03T09:00:00.000Z"),
    end: new Date("2026-11-03T09:30:00.000Z"),
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    attendeesCount: 3,
    meetingUrl: null,
    meetingPlatform: null,
    calendar: { selectedCalendarId: "sc-1", integration: "google_calendar", externalId: "me@example.com" },
    ...overrides,
  };
}

const labelFor = (event: ExternalCalendarEventDto) => `label:${event.calendar.externalId}`;

describe("toWeekCalendarEvents", () => {
  it("maps events to muted, status-less week events with ids from the external base", () => {
    const first = buildEvent();
    const second = buildEvent({ key: "sc-1:evt-2", title: "Review" });

    const result = toWeekCalendarEvents([first, second], WEEK_START, WEEK_END, labelFor);

    expect(result.events).toEqual([
      {
        id: EXTERNAL_EVENT_ID_BASE,
        title: "Standup",
        description: "label:me@example.com",
        start: first.start,
        end: first.end,
        options: { borderOnly: true, className: "text-subtle" },
      },
      expect.objectContaining({ id: EXTERNAL_EVENT_ID_BASE + 1, title: "Review" }),
    ]);
    expect(result.byId.get(EXTERNAL_EVENT_ID_BASE)).toBe(first);
    expect(result.byId.get(EXTERNAL_EVENT_ID_BASE + 1)).toBe(second);
  });

  it("skips all-day events", () => {
    const result = toWeekCalendarEvents([buildEvent({ isAllDay: true })], WEEK_START, WEEK_END, labelFor);

    expect(result.events).toEqual([]);
    expect(result.byId.size).toBe(0);
  });

  it("skips events starting outside the week and keeps ids contiguous", () => {
    const before = buildEvent({ key: "a", start: new Date("2026-11-01T23:00:00.000Z") });
    const atEnd = buildEvent({ key: "b", start: WEEK_END });
    const inside = buildEvent({ key: "c", start: WEEK_START });

    const result = toWeekCalendarEvents([before, atEnd, inside], WEEK_START, WEEK_END, labelFor);

    expect(result.events.map((event) => event.id)).toEqual([EXTERNAL_EVENT_ID_BASE]);
    expect(result.byId.get(EXTERNAL_EVENT_ID_BASE)).toBe(inside);
  });

  it("uses the untitled label when the event has no title", () => {
    const result = toWeekCalendarEvents(
      [buildEvent({ title: null })],
      WEEK_START,
      WEEK_END,
      labelFor,
      "(No title)"
    );

    expect(result.events[0].title).toBe("(No title)");
  });
});
