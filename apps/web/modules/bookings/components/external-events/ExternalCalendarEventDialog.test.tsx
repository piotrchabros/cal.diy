import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCalendarEventDialog } from "./ExternalCalendarEventDialog";

const mocks = vi.hoisted(() => ({
  notetakerEnabled: true,
  options: undefined as unknown,
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

vi.mock("@calcom/web/modules/notetaker/lib/NotetakerFeatureContext", () => ({
  useNotetakerFeatureEnabled: () => mocks.notetakerEnabled,
}));

vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerAdHoc", () => ({
  useNotetakerAdHoc: () => ({ options: { data: mocks.options } }),
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

const NOW = new Date("2026-11-04T10:05:00.000Z");
const MEET_LINK = "https://meet.google.com/abc-defg-hij";

function buildEvent(overrides: Partial<ExternalCalendarEventDto> = {}): ExternalCalendarEventDto {
  return {
    key: "sc-1:evt-1",
    title: "Planning",
    start: new Date("2026-11-04T10:00:00.000Z"),
    end: new Date("2026-11-04T11:00:00.000Z"),
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    attendeesCount: 4,
    meetingUrl: MEET_LINK,
    meetingPlatform: "GOOGLE_MEET",
    calendar: { selectedCalendarId: "sc-1", integration: "google_calendar", externalId: "me@example.com" },
    ...overrides,
  };
}

describe("ExternalCalendarEventDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mocks.notetakerEnabled = true;
    mocks.options = { featureEnabled: true, enabledPlatforms: ["GOOGLE_MEET"], maxDurationMinutes: 240 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while no event is selected", () => {
    render(<ExternalCalendarEventDialog event={null} onClose={vi.fn()} />);

    expect(screen.queryByTestId("external-calendar-event-dialog")).toBeNull();
  });

  it("shows the read-only details of the event", () => {
    render(<ExternalCalendarEventDialog event={buildEvent()} onClose={vi.fn()} />);

    expect(screen.getByTestId("dialog-title").textContent).toBe("Planning");
    expect(screen.getByTestId("dialog-subtitle").textContent).toBe("external_calendar_event_read_only");
    expect(screen.getByTestId("external-calendar-event-when").textContent).toContain("10:00 - 11:00");
    expect(screen.getByTestId("external-calendar-event-calendar").textContent).toBe(
      "external_calendar_integration_google · me@example.com"
    );
    expect(screen.getByTestId("external-calendar-event-attendees").textContent).toBe(
      "external_calendar_event_attendees_count:4"
    );
    const join = screen.getByTestId("external-calendar-event-join");
    expect(join.getAttribute("href")).toBe(MEET_LINK);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("falls back to the untitled label and the all-day label", () => {
    render(
      <ExternalCalendarEventDialog
        event={buildEvent({ title: null, isAllDay: true, attendeesCount: 0 })}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId("dialog-title").textContent).toBe("external_calendar_event_no_title");
    expect(screen.getByTestId("external-calendar-event-when").textContent).toContain(
      "external_calendar_event_all_day"
    );
    expect(screen.queryByTestId("external-calendar-event-attendees")).toBeNull();
  });

  it("closes itself and opens the prefilled notetaker dialog", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ExternalCalendarEventDialog event={buildEvent()} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("external-calendar-event-add-notetaker"));
    rerender(<ExternalCalendarEventDialog event={null} onClose={onClose} />);

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByTestId("external-calendar-event-dialog")).toBeNull();
    expect(JSON.parse(screen.getByTestId("notetaker-controlled").textContent ?? "")).toEqual({
      meetingUrl: MEET_LINK,
      title: "Planning",
      durationMinutes: 60,
    });
  });

  it("shows the later hint for supported meetings that start further out", () => {
    render(
      <ExternalCalendarEventDialog
        event={buildEvent({
          start: new Date("2026-11-04T12:00:00.000Z"),
          end: new Date("2026-11-04T13:00:00.000Z"),
        })}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByTestId("external-calendar-event-add-notetaker")).toBeNull();
    expect(screen.getByTestId("external-calendar-event-notetaker-later")).toBeTruthy();
  });

  it("hides the notetaker action when the notetaker feature is off", () => {
    mocks.notetakerEnabled = false;
    render(<ExternalCalendarEventDialog event={buildEvent()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("external-calendar-event-add-notetaker")).toBeNull();
    expect(screen.getByTestId("external-calendar-event-join")).toBeTruthy();
  });
});
