import type {
  ExternalCalendarEventDto,
  ExternalCalendarEventsDto,
} from "@calcom/lib/dto/ExternalCalendarEventDto";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCalendarEventsSection } from "./ExternalCalendarEventsSection";

type QueryResult = { data?: ExternalCalendarEventsDto; isPending: boolean; isError: boolean };

const mocks = vi.hoisted(() => ({
  query: { isPending: true, isError: false } as QueryResult,
  hookInputs: [] as { enabled: boolean; from: Date; to: Date }[],
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: { count?: number }) => (vars?.count ? `${key}:${vars.count}` : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("@calcom/features/bookings/lib", () => ({
  useTimePreferences: () => ({ timezone: "UTC", timeFormat: "HH:mm" }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../../hooks/useExternalCalendarEvents", () => ({
  useExternalCalendarEvents: (input: { enabled: boolean; from: Date; to: Date }) => {
    mocks.hookInputs.push(input);
    return mocks.query;
  },
}));

vi.mock("@calcom/web/modules/notetaker/lib/NotetakerFeatureContext", () => ({
  useNotetakerFeatureEnabled: () => true,
}));

vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerAdHoc", () => ({
  useNotetakerAdHoc: () => ({
    options: {
      data: { featureEnabled: true, enabledPlatforms: ["GOOGLE_MEET"], maxDurationMinutes: 240 },
    },
  }),
}));

vi.mock("@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog", () => ({
  NotetakerAddToMeetingDialogControlled: ({
    open,
    initialValues,
  }: {
    open: boolean;
    initialValues?: Record<string, unknown>;
  }) => (open ? <div data-testid="notetaker-controlled">{JSON.stringify(initialValues)}</div> : null),
}));

const NOW = new Date("2026-11-04T10:07:30.000Z");

function buildEvent(
  index: number,
  overrides: Partial<ExternalCalendarEventDto> = {}
): ExternalCalendarEventDto {
  return {
    key: `sc-1:evt-${index}`,
    title: `Event ${index}`,
    start: new Date(Date.UTC(2026, 10, 5, 8 + index)),
    end: new Date(Date.UTC(2026, 10, 5, 9 + index)),
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    attendeesCount: 0,
    meetingUrl: null,
    meetingPlatform: null,
    calendar: { selectedCalendarId: "sc-1", integration: "office365_calendar", externalId: "me@example.com" },
    ...overrides,
  };
}

function setData(events: ExternalCalendarEventDto[], extra: Partial<ExternalCalendarEventsDto> = {}) {
  mocks.query = {
    data: { available: true, events, failedCalendarCount: 0, ...extra },
    isPending: false,
    isError: false,
  };
}

function rows() {
  return screen.queryAllByTestId("external-calendar-event-row");
}

describe("ExternalCalendarEventsSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mocks.hookInputs = [];
    mocks.query = { isPending: true, isError: false };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries a week starting at now floored to five minutes", () => {
    render(<ExternalCalendarEventsSection enabled />);

    expect(mocks.hookInputs[0]).toEqual({
      enabled: true,
      from: new Date("2026-11-04T10:05:00.000Z"),
      to: new Date("2026-11-11T10:05:00.000Z"),
    });
  });

  it("shows a skeleton while loading", () => {
    render(<ExternalCalendarEventsSection enabled />);

    expect(screen.getByTestId("external-calendar-events-loading")).toBeTruthy();
  });

  it("renders nothing when disabled, unavailable, empty or failed", () => {
    const { rerender, container } = render(<ExternalCalendarEventsSection enabled={false} />);
    expect(container.innerHTML).toBe("");

    setData([buildEvent(1)], { available: false });
    rerender(<ExternalCalendarEventsSection enabled />);
    expect(container.innerHTML).toBe("");

    setData([]);
    rerender(<ExternalCalendarEventsSection enabled />);
    expect(container.innerHTML).toBe("");

    mocks.query = { isPending: false, isError: true };
    rerender(<ExternalCalendarEventsSection enabled />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a row per event with time, title, calendar and attendees", () => {
    setData([buildEvent(1, { attendeesCount: 2 }), buildEvent(2, { title: null, isAllDay: true })]);
    render(<ExternalCalendarEventsSection enabled />);

    expect(screen.getByTestId("external-calendar-events-count").textContent).toBe("2");
    const [first, second] = rows();
    expect(first.textContent).toContain("09:00 - 10:00");
    expect(first.textContent).toContain("Event 1");
    expect(first.textContent).toContain("external_calendar_integration_office365 · me@example.com");
    expect(first.textContent).toContain("external_calendar_event_attendees_count:2");
    expect(second.textContent).toContain("external_calendar_event_all_day");
    expect(second.textContent).toContain("external_calendar_event_no_title");
    expect(screen.queryByTestId("external-calendar-events-some-failed")).toBeNull();
  });

  it("collapses and expands the list from the header", () => {
    setData([buildEvent(1)]);
    render(<ExternalCalendarEventsSection enabled />);
    const toggle = screen.getByTestId("external-calendar-events-toggle");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);

    fireEvent.click(toggle);
    expect(rows()).toHaveLength(1);
  });

  it("shows ten rows until Show all is clicked", () => {
    setData(Array.from({ length: 12 }, (_, index) => buildEvent(index)));
    render(<ExternalCalendarEventsSection enabled />);
    const showAll = screen.getByTestId("external-calendar-events-show-all");

    expect(rows()).toHaveLength(10);
    expect(showAll.textContent).toBe("external_calendar_events_show_all:12");

    fireEvent.click(showAll);
    expect(rows()).toHaveLength(12);
    expect(showAll.textContent).toBe("external_calendar_events_show_less");
  });

  it("notes when some calendars failed to load", () => {
    setData([buildEvent(1)], { failedCalendarCount: 1 });
    render(<ExternalCalendarEventsSection enabled />);

    expect(screen.getByTestId("external-calendar-events-some-failed").textContent).toBe(
      "external_calendar_events_some_failed"
    );
  });

  it("opens the prefilled notetaker dialog from a row", () => {
    setData([
      buildEvent(1, {
        start: new Date("2026-11-04T10:00:00.000Z"),
        end: new Date("2026-11-04T10:30:00.000Z"),
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        meetingPlatform: "GOOGLE_MEET",
      }),
    ]);
    render(<ExternalCalendarEventsSection enabled />);

    expect(screen.getByTestId("external-calendar-event-join").getAttribute("href")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
    fireEvent.click(screen.getByTestId("external-calendar-event-add-notetaker"));

    expect(JSON.parse(screen.getByTestId("notetaker-controlled").textContent ?? "")).toEqual({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      title: "Event 1",
      durationMinutes: 30,
    });
  });
});
