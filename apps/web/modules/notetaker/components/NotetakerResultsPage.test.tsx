import type { NotetakerOutcomeReasonDto, NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerTranscriptDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotetakerResultsPage } from "./NotetakerResultsPage";

// The shared setup's `t` drops interpolation values; this makes the reason passed to the label observable.
vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

type StateQueryResult = {
  data: NotetakerStateDto | undefined;
  isLoading: boolean;
  error: { message: string } | null;
};

const mocks = vi.hoisted(() => ({
  useNotetakerState: vi.fn<(bookingUid: string) => StateQueryResult>(),
  regenerate: vi.fn<(input: { bookingUid: string }) => void>(),
}));

vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerState", () => ({
  useNotetakerState: mocks.useNotetakerState,
}));

vi.mock("@calcom/web/modules/notetaker/hooks/useNotetakerMutations", () => ({
  useNotetakerMutations: () => ({
    setEnabled: { mutate: () => undefined, isPending: false },
    stop: { mutate: () => undefined, isPending: false },
    regenerateSummary: { mutate: mocks.regenerate, isPending: false },
  }),
}));

vi.mock("@calcom/web/modules/notetaker/components/NotetakerTranscript", () => ({
  NotetakerTranscript: (props: {
    bookingUid: string;
    sessionId?: string;
    interruptedAtMs?: number | null;
    speakerNamesAvailable?: boolean | null;
  }) => (
    <div
      data-testid="transcript-stub"
      data-booking-uid={props.bookingUid}
      data-session-id={String(props.sessionId)}
      data-interrupted-at-ms={String(props.interruptedAtMs)}
      data-speaker-names-available={String(props.speakerNamesAvailable)}
    />
  ),
}));

vi.mock("@calcom/web/modules/notetaker/components/NotetakerSummary", () => ({
  NotetakerSummary: () => <div data-testid="summary-stub" />,
}));

type Session = NonNullable<NotetakerStateDto["session"]>;

function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    status: "READY",
    outcomeReason: null,
    startedLate: false,
    joinRequestedAt: "2026-01-01T10:00:00.000Z",
    admittedAt: "2026-01-01T10:01:00.000Z",
    endedAt: "2026-01-01T11:00:00.000Z",
    interruptedAtMs: null,
    resultsDeletedAt: null,
    ...overrides,
  };
}

function buildTranscript(overrides: Partial<NotetakerTranscriptDto> = {}): NotetakerTranscriptDto {
  return {
    id: "transcript-1",
    language: "en",
    completeness: "COMPLETE",
    durationMs: 60000,
    passageCount: 3,
    ...overrides,
  };
}

function buildState(overrides: Partial<NotetakerStateDto> = {}): NotetakerStateDto {
  return {
    bookingUid: "uid-1",
    featureEnabled: true,
    viewerRole: "HOST",
    eligibility: { eligible: true, platform: "GOOGLE_MEET", reason: null },
    choice: {
      enabled: true,
      source: "HOST",
      appliedToSeries: false,
      setByName: "Ada",
      setAt: "2026-01-01T09:00:00.000Z",
    },
    status: "READY",
    canToggle: false,
    canStop: false,
    isRecurring: false,
    session: buildSession(),
    transcript: buildTranscript(),
    summary: null,
    sharedWithAttendees: false,
    ...overrides,
  };
}

function renderPage(state: NotetakerStateDto) {
  mocks.useNotetakerState.mockReturnValue({ data: state, isLoading: false, error: null });
  render(<NotetakerResultsPage bookingUid="uid-1" />);
}

function partialState(
  outcomeReason: NotetakerOutcomeReasonDto | null,
  interruptedAtMs: number | null = null
) {
  return buildState({
    status: "ENDED_EARLY",
    session: buildSession({ status: "ENDED_EARLY", outcomeReason, interruptedAtMs }),
    transcript: buildTranscript({ completeness: "PARTIAL" }),
  });
}

describe("NotetakerResultsPage", () => {
  it("labels an interrupted partial transcript with the interrupted reason", () => {
    renderPage(partialState("INTERRUPTED"));

    expect(screen.getByTestId("notetaker-ended-early-label")).toHaveTextContent(
      'notetaker_transcript_incomplete:{"reason":"notetaker_reason_interrupted"}'
    );
  });

  it.each([
    ["NOT_ADMITTED", "notetaker_reason_not_admitted"],
    ["MEETING_DID_NOT_START", "notetaker_reason_meeting_did_not_start"],
    ["NO_SPEECH_DETECTED", "notetaker_reason_no_speech_detected"],
    ["LENGTH_LIMIT_REACHED", "notetaker_reason_length_limit_reached"],
    ["MEETING_LINK_UNUSABLE", "notetaker_reason_meeting_link_unusable"],
  ] as const)("labels a partial transcript ended by %s", (reason, expectedKey) => {
    renderPage(partialState(reason));

    expect(screen.getByTestId("notetaker-ended-early-label")).toHaveTextContent(
      `notetaker_transcript_incomplete:{"reason":"${expectedKey}"}`
    );
  });

  it("falls back to the interrupted reason when a partial transcript has no outcome reason", () => {
    renderPage(partialState(null));

    expect(screen.getByTestId("notetaker-ended-early-label")).toHaveTextContent(
      'notetaker_transcript_incomplete:{"reason":"notetaker_reason_interrupted"}'
    );
  });

  it("falls back to the interrupted reason when a partial transcript has no session", () => {
    renderPage(buildState({ session: null, transcript: buildTranscript({ completeness: "PARTIAL" }) }));

    expect(screen.getByTestId("notetaker-ended-early-label")).toHaveTextContent(
      'notetaker_transcript_incomplete:{"reason":"notetaker_reason_interrupted"}'
    );
  });

  it.each([
    ["REMOVED_BY_PARTICIPANT", "notetaker_ended_early_removed_by_participant"],
    ["STOPPED_BY_HOST", "notetaker_ended_early_stopped_by_host"],
  ] as const)("keeps the dedicated sentence for %s", (reason, expectedKey) => {
    renderPage(partialState(reason));

    expect(screen.getByTestId("notetaker-ended-early-label").textContent).toBe(expectedKey);
  });

  it("shows no labels for a complete transcript", () => {
    renderPage(buildState());

    expect(screen.queryByTestId("notetaker-ended-early-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-truncated-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-started-late")).not.toBeInTheDocument();
  });

  it("labels a truncated transcript and shows the length limit reason on the badge", () => {
    renderPage(
      buildState({
        status: "READY",
        session: buildSession({ status: "READY", outcomeReason: "LENGTH_LIMIT_REACHED" }),
        transcript: buildTranscript({ completeness: "TRUNCATED" }),
      })
    );

    expect(screen.getByTestId("notetaker-truncated-label")).toHaveTextContent(
      "notetaker_transcript_truncated"
    );
    expect(screen.queryByTestId("notetaker-ended-early-label")).not.toBeInTheDocument();
    expect(screen.getByTestId("notetaker-status-reason")).toHaveTextContent(
      "notetaker_reason_length_limit_reached"
    );
  });

  it("shows the started-late line before the summary", () => {
    renderPage(buildState({ session: buildSession({ startedLate: true }) }));

    const startedLate = screen.getByTestId("notetaker-started-late");
    expect(startedLate).toHaveTextContent("notetaker_started_late");
    expect(
      startedLate.compareDocumentPosition(screen.getByTestId("summary-stub")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("hides the started-late line when the session did not start late", () => {
    renderPage(buildState());

    expect(screen.queryByTestId("notetaker-started-late")).not.toBeInTheDocument();
  });

  it("shows the started-late line above the empty text when there is no transcript", () => {
    renderPage(buildState({ session: buildSession({ startedLate: true }), transcript: null }));

    const startedLate = screen.getByTestId("notetaker-started-late");
    expect(startedLate).toHaveTextContent("notetaker_started_late");
    expect(
      startedLate.compareDocumentPosition(screen.getByText("notetaker_transcript_empty")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows only the badge, its reason and the empty text for a failed session", () => {
    renderPage(
      buildState({
        status: "FAILED",
        session: buildSession({ status: "FAILED", outcomeReason: "NOT_ADMITTED" }),
        transcript: null,
      })
    );

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-reason")).toHaveTextContent("notetaker_reason_not_admitted");
    expect(screen.getByText("notetaker_transcript_empty")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("summary-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-ended-early-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-truncated-label")).not.toBeInTheDocument();
  });

  describe("transcript props", () => {
    it("passes the interruption offset for a partial transcript", () => {
      renderPage(partialState("INTERRUPTED", 4200));

      const stub = screen.getByTestId("transcript-stub");
      expect(stub).toHaveAttribute("data-interrupted-at-ms", "4200");
      expect(stub).toHaveAttribute("data-booking-uid", "uid-1");
      expect(stub).toHaveAttribute("data-session-id", "undefined");
    });

    it.each(["COMPLETE", "TRUNCATED"] as const)("passes null for a %s transcript", (completeness) => {
      renderPage(
        buildState({
          session: buildSession({ interruptedAtMs: 4200 }),
          transcript: buildTranscript({ completeness }),
        })
      );

      expect(screen.getByTestId("transcript-stub")).toHaveAttribute("data-interrupted-at-ms", "null");
    });

    it.each([true, false, null])("passes the speaker names flag %s to the transcript", (flag) => {
      renderPage(buildState({ transcript: buildTranscript({ speakerNamesAvailable: flag }) }));

      expect(screen.getByTestId("transcript-stub")).toHaveAttribute(
        "data-speaker-names-available",
        String(flag)
      );
    });

    it("passes an absent speaker names flag as undefined", () => {
      renderPage(buildState());

      expect(screen.getByTestId("transcript-stub")).toHaveAttribute(
        "data-speaker-names-available",
        "undefined"
      );
    });

    it("passes null for a partial transcript without an interruption offset", () => {
      renderPage(partialState("INTERRUPTED", null));

      expect(screen.getByTestId("transcript-stub")).toHaveAttribute("data-interrupted-at-ms", "null");
    });
  });

  it("shows no reason on the badge when the booking was re-armed after a failure", () => {
    renderPage(
      buildState({
        status: "SCHEDULED",
        session: buildSession({ status: "FAILED", outcomeReason: "NOT_ADMITTED" }),
        transcript: null,
      })
    );

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it("renders no badge without a status", () => {
    renderPage(buildState({ status: null, session: null, transcript: null }));

    expect(screen.queryByTestId("notetaker-status-badge")).not.toBeInTheDocument();
  });

  it("renders the loading state", () => {
    mocks.useNotetakerState.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<NotetakerResultsPage bookingUid="uid-1" />);

    expect(screen.getByRole("status", { name: "loading" })).toBeInTheDocument();
  });

  it("hides the error message", () => {
    mocks.useNotetakerState.mockReturnValue({ data: undefined, isLoading: false, error: { message: "x" } });
    render(<NotetakerResultsPage bookingUid="uid-1" />);

    expect(screen.getByText("something_went_wrong")).toBeInTheDocument();
    expect(screen.queryByText("x")).not.toBeInTheDocument();
  });

  it("loads the state of the given booking", () => {
    renderPage(buildState());

    expect(mocks.useNotetakerState).toHaveBeenCalledWith("uid-1");
  });
});

vi.mock("@calcom/web/modules/notetaker/components/NotetakerResultsActions", () => ({
  NotetakerResultsActions: (props: {
    bookingUid: string;
    viewerRole: string;
    sharedWithAttendees: boolean;
    sessionStatus: string | null;
  }) => (
    <div
      data-testid="results-actions-stub"
      data-booking-uid={props.bookingUid}
      data-viewer-role={props.viewerRole}
      data-shared-with-attendees={String(props.sharedWithAttendees)}
      data-session-status={String(props.sessionStatus)}
    />
  ),
}));

vi.mock("@calcom/web/modules/notetaker/components/NotetakerActivityList", () => ({
  NotetakerActivityList: (props: { bookingUid: string }) => (
    <div data-testid="activity-list-stub" data-booking-uid={props.bookingUid} />
  ),
}));

vi.mock("@calcom/web/modules/notetaker/components/NotetakerAccessSummary", () => ({
  NotetakerAccessSummary: (props: { access: { attendees: boolean } }) => (
    <div data-testid="access-summary-stub" data-attendees={String(props.access.attendees)} />
  ),
}));

const DELETED_AT = "2026-01-02T00:00:00.000Z";

describe("NotetakerResultsPage sharing, export, deletion and activity", () => {
  it("gives a host with a transcript the actions with the four props and the activity list", () => {
    renderPage(buildState({ sharedWithAttendees: true }));

    const actions = screen.getByTestId("results-actions-stub");
    expect(actions).toHaveAttribute("data-booking-uid", "uid-1");
    expect(actions).toHaveAttribute("data-viewer-role", "HOST");
    expect(actions).toHaveAttribute("data-shared-with-attendees", "true");
    expect(actions).toHaveAttribute("data-session-status", "READY");
    expect(screen.getByTestId("activity-list-stub")).toHaveAttribute("data-booking-uid", "uid-1");
  });

  it("passes the status of the session, not the booking status, to the actions", () => {
    renderPage(buildState({ status: "SCHEDULED", session: buildSession({ status: "FAILED" }) }));

    const actions = screen.getByTestId("results-actions-stub");
    expect(actions).toHaveAttribute("data-session-status", "FAILED");
    expect(actions).toHaveAttribute("data-shared-with-attendees", "false");
  });

  it("passes a null session status when there is no session", () => {
    renderPage(buildState({ session: null }));

    expect(screen.getByTestId("results-actions-stub")).toHaveAttribute("data-session-status", "null");
  });

  it("puts the actions first in the transcript block and the activity list last on the page", () => {
    renderPage(partialState("INTERRUPTED"));

    const actions = screen.getByTestId("results-actions-stub");
    const activity = screen.getByTestId("activity-list-stub");
    expect(
      screen.getByTestId("notetaker-status-badge").compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      actions.compareDocumentPosition(screen.getByTestId("notetaker-ended-early-label")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByTestId("transcript-stub").compareDocumentPosition(activity) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(activity.parentElement?.lastElementChild).toBe(activity);
  });

  it("gives an attendee the actions as an attendee and no activity list", () => {
    renderPage(buildState({ viewerRole: "ATTENDEE", sharedWithAttendees: true }));

    expect(screen.getByTestId("results-actions-stub")).toHaveAttribute("data-viewer-role", "ATTENDEE");
    expect(screen.getByTestId("summary-stub")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-list-stub")).not.toBeInTheDocument();
  });

  it("shows a host the deleted statement and the activity list, and nothing of the results", () => {
    renderPage(buildState({ transcript: null, session: buildSession({ resultsDeletedAt: DELETED_AT }) }));

    expect(screen.getByTestId("notetaker-results-deleted").textContent).toBe("notetaker_results_deleted");
    expect(screen.queryByText("notetaker_transcript_empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("summary-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transcript-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("results-actions-stub")).not.toBeInTheDocument();

    const activity = screen.getByTestId("activity-list-stub");
    expect(activity).toHaveAttribute("data-booking-uid", "uid-1");
    expect(activity.parentElement?.lastElementChild).toBe(activity);
  });

  it("keeps the started-late line above the deleted statement", () => {
    renderPage(
      buildState({
        transcript: null,
        session: buildSession({ startedLate: true, resultsDeletedAt: DELETED_AT }),
      })
    );

    expect(
      screen
        .getByTestId("notetaker-started-late")
        .compareDocumentPosition(screen.getByTestId("notetaker-results-deleted")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows an attendee the deleted statement without the activity list", () => {
    renderPage(
      buildState({
        viewerRole: "ATTENDEE",
        transcript: null,
        session: buildSession({ resultsDeletedAt: DELETED_AT }),
      })
    );

    expect(screen.getByTestId("notetaker-results-deleted")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-list-stub")).not.toBeInTheDocument();
  });

  it("keeps the empty text when there is no transcript and nothing was deleted", () => {
    renderPage(buildState({ transcript: null }));

    expect(screen.getByText("notetaker_transcript_empty")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("results-actions-stub")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-list-stub")).toBeInTheDocument();
  });

  it("keeps the empty text when there is no transcript and no session", () => {
    renderPage(buildState({ status: null, session: null, transcript: null }));

    expect(screen.getByText("notetaker_transcript_empty")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
  });

  it("shows no deleted statement while a transcript exists", () => {
    renderPage(buildState({ session: buildSession({ resultsDeletedAt: DELETED_AT }) }));

    expect(screen.queryByTestId("notetaker-results-deleted")).not.toBeInTheDocument();
    expect(screen.getByTestId("transcript-stub")).toBeInTheDocument();
  });

  it("still renders the transcript block when the feature is disabled for the reader", () => {
    renderPage(buildState({ featureEnabled: false, viewerRole: "ATTENDEE", sharedWithAttendees: true }));

    expect(screen.getByTestId("results-actions-stub")).toBeInTheDocument();
    expect(screen.getByTestId("summary-stub")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-stub")).toBeInTheDocument();
  });

  describe("access summary and shared viewer", () => {
    const access = { attendees: true, colleagues: null };

    it("shows a host with access the summary above the activity list", () => {
      renderPage(buildState({ access }));

      const summary = screen.getByTestId("access-summary-stub");
      expect(summary).toHaveAttribute("data-attendees", "true");
      expect(
        summary.compareDocumentPosition(screen.getByTestId("activity-list-stub")) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("shows a host without access no summary", () => {
      renderPage(buildState());

      expect(screen.queryByTestId("access-summary-stub")).not.toBeInTheDocument();
    });

    it.each(["ATTENDEE", "SHARED_VIEWER"] as const)("shows %s no summary", (viewerRole) => {
      renderPage(buildState({ viewerRole, access }));

      expect(screen.queryByTestId("access-summary-stub")).not.toBeInTheDocument();
    });

    it("gives a shared viewer status, actions, summary and transcript but no activity list", () => {
      renderPage(buildState({ viewerRole: "SHARED_VIEWER" }));

      expect(screen.getByTestId("notetaker-status-badge")).toBeInTheDocument();
      expect(screen.getByTestId("results-actions-stub")).toHaveAttribute("data-viewer-role", "SHARED_VIEWER");
      expect(screen.getByTestId("summary-stub")).toBeInTheDocument();
      expect(screen.getByTestId("transcript-stub")).toBeInTheDocument();
      expect(screen.queryByTestId("activity-list-stub")).not.toBeInTheDocument();
    });
  });
});
