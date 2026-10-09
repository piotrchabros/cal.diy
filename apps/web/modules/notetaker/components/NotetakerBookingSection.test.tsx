import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
});
