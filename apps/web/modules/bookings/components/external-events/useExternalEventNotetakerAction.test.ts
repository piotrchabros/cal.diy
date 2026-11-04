import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { describe, expect, it } from "vitest";
import { getExternalEventNotetakerAction } from "./useExternalEventNotetakerAction";

const START = new Date("2026-11-04T10:00:00.000Z");
const END = new Date("2026-11-04T11:00:00.000Z");
const OPTIONS = { featureEnabled: true, enabledPlatforms: ["GOOGLE_MEET" as const], maxDurationMinutes: 120 };

function buildEvent(overrides: Partial<ExternalCalendarEventDto> = {}): ExternalCalendarEventDto {
  return {
    key: "sc-1:evt-1",
    title: "Planning",
    start: START,
    end: END,
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    attendeesCount: 2,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingPlatform: "GOOGLE_MEET",
    calendar: { selectedCalendarId: "sc-1", integration: "google_calendar", externalId: "me@example.com" },
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe("getExternalEventNotetakerAction", () => {
  it("is available from ten minutes before the start with the remaining time snapped up", () => {
    expect(getExternalEventNotetakerAction(buildEvent(), at("2026-11-04T09:50:00.000Z"), OPTIONS)).toEqual({
      state: "available",
      initialValues: {
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        title: "Planning",
        durationMinutes: 90,
      },
    });
    expect(
      getExternalEventNotetakerAction(buildEvent(), at("2026-11-04T10:40:30.000Z"), OPTIONS)
    ).toMatchObject({ state: "available", initialValues: { durationMinutes: 30 } });
  });

  it("caps the duration at the largest allowed choice", () => {
    const longEvent = buildEvent({ end: new Date("2026-11-04T16:00:00.000Z") });

    expect(getExternalEventNotetakerAction(longEvent, at("2026-11-04T10:00:00.000Z"), OPTIONS)).toMatchObject(
      { initialValues: { durationMinutes: 120 } }
    );
  });

  it("leaves the title out when the event has none", () => {
    const action = getExternalEventNotetakerAction(
      buildEvent({ title: null }),
      at("2026-11-04T10:00:00.000Z"),
      OPTIONS
    );

    expect(action).toMatchObject({ state: "available", initialValues: { title: undefined } });
  });

  it("is later before the lead window", () => {
    expect(getExternalEventNotetakerAction(buildEvent(), at("2026-11-04T09:49:59.000Z"), OPTIONS)).toEqual({
      state: "later",
    });
  });

  it("is hidden once the meeting has ended", () => {
    expect(getExternalEventNotetakerAction(buildEvent(), END, OPTIONS)).toEqual({ state: "hidden" });
  });

  it.each([
    ["all-day events", buildEvent({ isAllDay: true })],
    ["events without a meeting link", buildEvent({ meetingUrl: null, meetingPlatform: null })],
    ["platforms that are not enabled", buildEvent({ meetingPlatform: "MICROSOFT_TEAMS" })],
  ])("is hidden for %s", (_label, event) => {
    expect(getExternalEventNotetakerAction(event, at("2026-11-04T10:00:00.000Z"), OPTIONS)).toEqual({
      state: "hidden",
    });
  });

  it("is hidden while the options are missing or the feature is off", () => {
    const now = at("2026-11-04T10:00:00.000Z");

    expect(getExternalEventNotetakerAction(buildEvent(), now, undefined)).toEqual({ state: "hidden" });
    expect(getExternalEventNotetakerAction(buildEvent(), now, { ...OPTIONS, featureEnabled: false })).toEqual(
      {
        state: "hidden",
      }
    );
  });
});
