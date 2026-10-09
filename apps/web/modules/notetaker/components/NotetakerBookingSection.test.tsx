import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerBookingSection } from "./NotetakerBookingSection";

type NotetakerStateQuery = { data: NotetakerStateDto | undefined; isPending: boolean; isError: boolean };
type NotetakerSession = NonNullable<NotetakerStateDto["session"]>;
type NotetakerChoice = NonNullable<NotetakerStateDto["choice"]>;

const BOOKING_UID = "booking-uid-1";

const mocks = vi.hoisted(() => ({
  useNotetakerState: vi.fn<(bookingUid: string) => NotetakerStateQuery>(),
  setEnabledMutate: vi.fn<(input: { bookingUid: string; enabled: boolean; scope: string }) => void>(),
  stopMutate: vi.fn<(input: { bookingUid: string }) => void>(),
  regenerateSummaryMutate: vi.fn<(input: { bookingUid: string }) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../hooks/useNotetakerState", () => ({
  useNotetakerState: mocks.useNotetakerState,
}));

// A plain function, not vi.fn: the shared setup runs vi.resetAllMocks() after each test, which would empty a mocked return value.
vi.mock("../hooks/useNotetakerMutations", () => ({
  useNotetakerMutations: () => ({
    setEnabled: { mutate: mocks.setEnabledMutate, isPending: false },
    stop: { mutate: mocks.stopMutate, isPending: false },
    regenerateSummary: { mutate: mocks.regenerateSummaryMutate, isPending: false },
  }),
}));

function buildChoice(overrides: Partial<NotetakerChoice> = {}): NotetakerChoice {
  return {
    enabled: true,
    source: "HOST",
    appliedToSeries: false,
    setByName: "Ada",
    setAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function buildSession(overrides: Partial<NotetakerSession> = {}): NotetakerSession {
  return {
    id: "session-1",
    status: "FAILED",
    outcomeReason: "NOT_ADMITTED",
    startedLate: false,
    joinRequestedAt: "2026-01-01T10:00:00.000Z",
    admittedAt: null,
    endedAt: "2026-01-01T10:15:00.000Z",
    interruptedAtMs: null,
    resultsDeletedAt: null,
    ...overrides,
  };
}

function buildState(overrides: Partial<NotetakerStateDto> = {}): NotetakerStateDto {
  return {
    bookingUid: BOOKING_UID,
    featureEnabled: true,
    viewerRole: "HOST",
    eligibility: { eligible: true, platform: "GOOGLE_MEET", reason: null },
    choice: null,
    status: null,
    canToggle: true,
    canStop: false,
    isRecurring: false,
    session: null,
    transcript: null,
    summary: null,
    sharedWithAttendees: false,
    ...overrides,
  };
}

function renderSection(state: NotetakerStateDto, query: Partial<NotetakerStateQuery> = {}): void {
  mocks.useNotetakerState.mockReturnValue({ data: state, isPending: false, isError: false, ...query });
  render(<NotetakerBookingSection bookingUid={BOOKING_UID} />);
}

const STATUSES_WITHOUT_BANNER: NotetakerStateDto["status"][] = [
  null,
  "SCHEDULED",
  "TRANSCRIBING",
  "PROCESSING",
  "READY",
  "ENDED_EARLY",
  "FAILED",
];

describe("NotetakerBookingSection", () => {
  // The shared setup's reset does not clear the hoisted mutate spies between tests, so call counts would leak into the "does not mutate" cases.
  beforeEach(() => {
    mocks.setEnabledMutate.mockClear();
  });

  it("shows the admit banner above the toggle while waiting to be admitted", () => {
    renderSection(
      buildState({
        status: "WAITING_TO_BE_ADMITTED",
        choice: buildChoice(),
        session: buildSession({ status: "WAITING_TO_BE_ADMITTED", outcomeReason: null, endedAt: null }),
      })
    );

    const banner = screen.getByTestId("notetaker-admit-banner");
    expect(within(banner).getByTestId("alert")).toBeInTheDocument();
    expect(banner).toHaveTextContent("notetaker_admit_banner_title");
    expect(banner).toHaveTextContent("notetaker_admit_banner_description");

    const toggle = screen.getByTestId("notetaker-toggle");
    expect(banner.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
    expect(mocks.useNotetakerState).toHaveBeenCalledWith(BOOKING_UID);
  });

  it.each(STATUSES_WITHOUT_BANNER)("shows no admit banner for status %s", (status) => {
    renderSection(buildState({ status, choice: buildChoice() }));

    expect(screen.getByTestId("notetaker-booking-section")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-admit-banner")).not.toBeInTheDocument();
  });

  it("shows the reason and an enabled, checked toggle after a FAILED session", () => {
    renderSection(
      buildState({
        status: "FAILED",
        choice: buildChoice({ enabled: true }),
        canToggle: true,
        session: buildSession({ status: "FAILED", outcomeReason: "NOT_ADMITTED" }),
      })
    );

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe("notetaker_status_failed");
    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe("notetaker_reason_not_admitted");

    const toggle = screen.getByTestId("notetaker-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
  });

  it("turns the notetaker off when the toggle is clicked after a FAILED session", () => {
    renderSection(
      buildState({ status: "FAILED", choice: buildChoice({ enabled: true }), session: buildSession() })
    );

    fireEvent.click(screen.getByTestId("notetaker-toggle"));

    expect(mocks.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setEnabledMutate).toHaveBeenCalledWith({
      bookingUid: BOOKING_UID,
      enabled: false,
      scope: "THIS_BOOKING",
    });
  });

  it("disables the toggle after a FAILED session when canToggle is false", () => {
    renderSection(
      buildState({
        status: "FAILED",
        choice: buildChoice({ enabled: true }),
        canToggle: false,
        session: buildSession(),
      })
    );

    expect(screen.getByTestId("notetaker-toggle")).toBeDisabled();
  });

  it("shows no reason for a re-armed SCHEDULED status whose session is the old FAILED one", () => {
    renderSection(
      buildState({
        status: "SCHEDULED",
        choice: buildChoice({ enabled: true }),
        session: buildSession({ status: "FAILED", outcomeReason: "NOT_ADMITTED" }),
      })
    );

    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe("notetaker_status_scheduled");
    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it("shows the length limit note beside a READY status", () => {
    renderSection(
      buildState({
        status: "READY",
        choice: buildChoice(),
        session: buildSession({ status: "READY", outcomeReason: "LENGTH_LIMIT_REACHED" }),
      })
    );

    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe(
      "notetaker_reason_length_limit_reached"
    );
  });

  it("renders no badge when there is no status", () => {
    renderSection(buildState());

    expect(screen.getByTestId("notetaker-booking-section")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-status-badge")).not.toBeInTheDocument();
  });

  it("renders nothing while the state is loading", () => {
    renderSection(buildState(), { data: undefined, isPending: true });

    expect(screen.queryByTestId("notetaker-booking-section")).not.toBeInTheDocument();
  });

  it("renders nothing when the feature is disabled", () => {
    renderSection(buildState({ featureEnabled: false, status: "WAITING_TO_BE_ADMITTED" }));

    expect(screen.queryByTestId("notetaker-booking-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-admit-banner")).not.toBeInTheDocument();
  });

  it("shows the event type default sentence for an enabled inherited choice", () => {
    renderSection(
      buildState({ choice: buildChoice({ enabled: true, source: "EVENT_TYPE_DEFAULT", setByName: null }) })
    );

    const text = screen.getByTestId("notetaker-booking-section").textContent;
    expect(text).toContain("notetaker_enabled_by_event_type_default");
    expect(text).not.toContain("notetaker_enabled_by:");
    expect(text).not.toContain("notetaker_enabled_at");
  });

  it("shows the event type default sentence even when the inherited choice carries a name", () => {
    renderSection(
      buildState({ choice: buildChoice({ enabled: true, source: "EVENT_TYPE_DEFAULT", setByName: "Ada" }) })
    );

    const text = screen.getByTestId("notetaker-booking-section").textContent;
    expect(text).toContain("notetaker_enabled_by_event_type_default");
    expect(text).not.toContain("notetaker_enabled_by:");
    expect(text).not.toContain("notetaker_enabled_at");
  });

  it("keeps the disabled sentence for a disabled inherited choice", () => {
    renderSection(
      buildState({ choice: buildChoice({ enabled: false, source: "EVENT_TYPE_DEFAULT", setByName: null }) })
    );

    const text = screen.getByTestId("notetaker-booking-section").textContent;
    expect(text).toContain("notetaker_disabled_at");
    expect(text).not.toContain("notetaker_enabled_by_event_type_default");
  });

  it("mutates at once with THIS_BOOKING when the booking is not recurring", () => {
    renderSection(buildState({ isRecurring: false }));

    fireEvent.click(screen.getByTestId("notetaker-toggle"));

    expect(mocks.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setEnabledMutate).toHaveBeenCalledWith({
      bookingUid: BOOKING_UID,
      enabled: true,
      scope: "THIS_BOOKING",
    });
    expect(screen.queryByTestId("notetaker-scope-dialog")).not.toBeInTheDocument();
  });

  it("opens the scope dialog and does not mutate when the booking is recurring", () => {
    renderSection(buildState({ isRecurring: true, choice: buildChoice({ enabled: false }) }));

    fireEvent.click(screen.getByTestId("notetaker-toggle"));

    const dialog = screen.getByTestId("notetaker-scope-dialog");
    expect(dialog.textContent).toContain("notetaker_scope_title");
    expect(dialog.textContent).toContain("notetaker_scope_description");
    expect(mocks.setEnabledMutate).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true, buttonId: "notetaker-scope-this-booking", scope: "THIS_BOOKING" },
    { enabled: true, buttonId: "notetaker-scope-all-future-occurrences", scope: "ALL_FUTURE_OCCURRENCES" },
    { enabled: false, buttonId: "notetaker-scope-this-booking", scope: "THIS_BOOKING" },
    { enabled: false, buttonId: "notetaker-scope-all-future-occurrences", scope: "ALL_FUTURE_OCCURRENCES" },
  ])("mutates with enabled $enabled and scope $scope from the scope dialog", ({
    enabled,
    buttonId,
    scope,
  }) => {
    renderSection(buildState({ isRecurring: true, choice: buildChoice({ enabled: !enabled }) }));

    fireEvent.click(screen.getByTestId("notetaker-toggle"));
    fireEvent.click(within(screen.getByTestId("notetaker-scope-dialog")).getByTestId(buttonId));

    expect(mocks.setEnabledMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setEnabledMutate).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, enabled, scope });
    expect(screen.queryByTestId("notetaker-scope-dialog")).not.toBeInTheDocument();
  });

  it("closes the scope dialog without mutating on cancel", () => {
    renderSection(buildState({ isRecurring: true, choice: buildChoice({ enabled: false }) }));

    fireEvent.click(screen.getByTestId("notetaker-toggle"));
    fireEvent.click(
      within(screen.getByTestId("notetaker-scope-dialog")).getByTestId("notetaker-scope-cancel")
    );

    expect(screen.queryByTestId("notetaker-scope-dialog")).not.toBeInTheDocument();
    expect(mocks.setEnabledMutate).not.toHaveBeenCalled();
  });
});

type NotetakerTranscript = NonNullable<NotetakerStateDto["transcript"]>;

const TRANSCRIPT: NotetakerTranscript = {
  id: "transcript-1",
  language: "en",
  completeness: "COMPLETE",
  durationMs: 60000,
  passageCount: 3,
};

const DELETED_AT = "2026-01-02T00:00:00.000Z";

describe("NotetakerBookingSection for an attendee", () => {
  it("shows the status and the transcript link only", () => {
    renderSection(
      buildState({
        viewerRole: "ATTENDEE",
        status: "READY",
        canToggle: false,
        session: buildSession({ status: "READY", outcomeReason: null }),
        transcript: TRANSCRIPT,
        sharedWithAttendees: true,
      })
    );

    const section = screen.getByTestId("notetaker-booking-section");
    expect(section.textContent).toContain("notetaker_section_title");
    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe("notetaker_status_ready");

    const link = screen.getByTestId("notetaker-view-transcript");
    expect(link).toHaveAttribute("href", `/booking/${BOOKING_UID}/notetaker`);
    expect(link.textContent).toBe("notetaker_view_transcript");

    expect(screen.queryByTestId("notetaker-toggle")).not.toBeInTheDocument();
    expect(section.textContent).not.toContain("notetaker_toggle_description");
  });

  it("hides the switch, the reason, the banner, the stop button and the choice sentence", () => {
    renderSection(
      buildState({
        viewerRole: "ATTENDEE",
        status: "WAITING_TO_BE_ADMITTED",
        canToggle: true,
        canStop: true,
        choice: buildChoice(),
        eligibility: { eligible: false, platform: "GOOGLE_MEET", reason: "MEETING_ENDED" },
        session: buildSession({ status: "WAITING_TO_BE_ADMITTED", outcomeReason: null, endedAt: null }),
      })
    );

    const text = screen.getByTestId("notetaker-booking-section").textContent;
    expect(screen.queryByTestId("notetaker-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-admit-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-stop-button")).not.toBeInTheDocument();
    expect(text).not.toContain("notetaker_unavailable_meeting_ended");
    expect(text).not.toContain("notetaker_toggle_description");
    expect(text).not.toContain("notetaker_enabled_by");
    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe(
      "notetaker_status_waiting_to_be_admitted"
    );
  });

  it("hides the rejoin blocked sentence", () => {
    renderSection(
      buildState({
        viewerRole: "ATTENDEE",
        eligibility: { eligible: false, platform: "GOOGLE_MEET", reason: "REJOIN_BLOCKED" },
      })
    );

    expect(screen.getByTestId("notetaker-booking-section")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-rejoin-blocked")).not.toBeInTheDocument();
  });

  it("renders only the title when there is no status and no transcript", () => {
    renderSection(buildState({ viewerRole: "ATTENDEE" }));

    expect(screen.getByTestId("notetaker-booking-section").textContent).toBe("notetaker_section_title");
    expect(screen.queryByTestId("notetaker-status-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-view-transcript")).not.toBeInTheDocument();
  });

  it("shows the reason beside the status under the same rule as for a host", () => {
    renderSection(
      buildState({
        viewerRole: "ATTENDEE",
        status: "FAILED",
        session: buildSession({ status: "FAILED", outcomeReason: "NOT_ADMITTED" }),
      })
    );

    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe("notetaker_reason_not_admitted");
    expect(screen.queryByTestId("notetaker-toggle")).not.toBeInTheDocument();
  });

  it("shows no deleted line", () => {
    renderSection(
      buildState({
        viewerRole: "ATTENDEE",
        status: "READY",
        session: buildSession({ status: "READY", outcomeReason: null, resultsDeletedAt: DELETED_AT }),
      })
    );

    expect(screen.getByTestId("notetaker-booking-section")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-toggle")).not.toBeInTheDocument();
  });

  it("renders nothing when the feature is disabled", () => {
    renderSection(buildState({ viewerRole: "ATTENDEE", featureEnabled: false, transcript: TRANSCRIPT }));

    expect(screen.queryByTestId("notetaker-booking-section")).not.toBeInTheDocument();
  });
});

describe("NotetakerBookingSection after the results were deleted", () => {
  it("shows a host the deleted line last in the section and no transcript link", () => {
    renderSection(
      buildState({
        status: "READY",
        choice: buildChoice(),
        session: buildSession({ status: "READY", outcomeReason: null, resultsDeletedAt: DELETED_AT }),
      })
    );

    const deleted = screen.getByTestId("notetaker-results-deleted");
    expect(deleted.textContent).toBe("notetaker_results_deleted");
    expect(screen.getByTestId("notetaker-booking-section").lastElementChild).toBe(deleted);
    expect(screen.queryByTestId("notetaker-view-transcript")).not.toBeInTheDocument();
    expect(screen.getByTestId("notetaker-toggle")).toBeInTheDocument();
  });

  it("shows the transcript link and no deleted line while a transcript exists", () => {
    renderSection(
      buildState({
        status: "READY",
        session: buildSession({ status: "READY", outcomeReason: null, resultsDeletedAt: DELETED_AT }),
        transcript: TRANSCRIPT,
      })
    );

    expect(screen.getByTestId("notetaker-view-transcript")).toHaveAttribute(
      "href",
      `/booking/${BOOKING_UID}/notetaker`
    );
    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
  });

  it("shows no deleted line when nothing was deleted", () => {
    renderSection(buildState({ status: "FAILED", session: buildSession() }));

    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
  });

  it("shows no deleted line without a session", () => {
    renderSection(buildState());

    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
  });
});
