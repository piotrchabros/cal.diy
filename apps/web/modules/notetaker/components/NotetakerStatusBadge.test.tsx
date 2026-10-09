import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotetakerStatusBadge } from "./NotetakerStatusBadge";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

const STATUS_LABEL_KEYS: Record<NotetakerSessionStatusDto, string> = {
  SCHEDULED: "notetaker_status_scheduled",
  WAITING_TO_BE_ADMITTED: "notetaker_status_waiting_to_be_admitted",
  TRANSCRIBING: "notetaker_status_transcribing",
  PROCESSING: "notetaker_status_processing",
  READY: "notetaker_status_ready",
  ENDED_EARLY: "notetaker_status_ended_early",
  FAILED: "notetaker_status_failed",
};

// Written out instead of imported from outcomeReasonKeys.ts so a wrong entry in that map fails here.
const REASON_KEYS: Record<NotetakerOutcomeReasonDto, string> = {
  NOT_ADMITTED: "notetaker_reason_not_admitted",
  MEETING_DID_NOT_START: "notetaker_reason_meeting_did_not_start",
  NO_SPEECH_DETECTED: "notetaker_reason_no_speech_detected",
  REMOVED_BY_PARTICIPANT: "notetaker_reason_removed_by_participant",
  STOPPED_BY_HOST: "notetaker_reason_stopped_by_host",
  INTERRUPTED: "notetaker_reason_interrupted",
  LENGTH_LIMIT_REACHED: "notetaker_reason_length_limit_reached",
  MEETING_LINK_UNUSABLE: "notetaker_reason_meeting_link_unusable",
};

const ALL_STATUSES: NotetakerSessionStatusDto[] = [
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
  "PROCESSING",
  "READY",
  "ENDED_EARLY",
  "FAILED",
];
const LIVE_STATUSES: NotetakerSessionStatusDto[] = [
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
  "PROCESSING",
];
const ALL_REASONS: NotetakerOutcomeReasonDto[] = [
  "NOT_ADMITTED",
  "MEETING_DID_NOT_START",
  "NO_SPEECH_DETECTED",
  "REMOVED_BY_PARTICIPANT",
  "STOPPED_BY_HOST",
  "INTERRUPTED",
  "LENGTH_LIMIT_REACHED",
  "MEETING_LINK_UNUSABLE",
];
const REASONS_WITHOUT_LENGTH_LIMIT: NotetakerOutcomeReasonDto[] = ALL_REASONS.filter(
  (reason) => reason !== "LENGTH_LIMIT_REACHED"
);

describe("NotetakerStatusBadge", () => {
  it.each(ALL_STATUSES)("renders exactly one badge and no reason for %s without a reason", (status) => {
    render(<NotetakerStatusBadge status={status} />);

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe(STATUS_LABEL_KEYS[status]);
    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it.each(ALL_REASONS)("shows the reason beside a FAILED status: %s", (reason) => {
    render(<NotetakerStatusBadge status="FAILED" outcomeReason={reason} />);

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe(REASON_KEYS[reason]);
  });

  it.each(ALL_REASONS)("shows the reason beside an ENDED_EARLY status: %s", (reason) => {
    render(<NotetakerStatusBadge status="ENDED_EARLY" outcomeReason={reason} />);

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe(REASON_KEYS[reason]);
  });

  it("shows the length limit note for READY with LENGTH_LIMIT_REACHED", () => {
    render(<NotetakerStatusBadge status="READY" outcomeReason="LENGTH_LIMIT_REACHED" />);

    expect(screen.getByTestId("notetaker-status-badge").textContent).toBe("notetaker_status_ready");
    expect(screen.getByTestId("notetaker-status-reason").textContent).toBe(
      "notetaker_reason_length_limit_reached"
    );
  });

  it("shows no reason for READY with a null reason", () => {
    render(<NotetakerStatusBadge status="READY" outcomeReason={null} />);

    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it.each(REASONS_WITHOUT_LENGTH_LIMIT)("shows no reason for READY with %s", (reason) => {
    render(<NotetakerStatusBadge status="READY" outcomeReason={reason} />);

    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it.each(LIVE_STATUSES)("shows no reason for the live status %s even with a reason", (status) => {
    render(<NotetakerStatusBadge status={status} outcomeReason="INTERRUPTED" />);

    expect(screen.getAllByTestId("notetaker-status-badge")).toHaveLength(1);
    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it("shows no reason for FAILED with a null reason", () => {
    render(<NotetakerStatusBadge status="FAILED" outcomeReason={null} />);

    expect(screen.queryByTestId("notetaker-status-reason")).not.toBeInTheDocument();
  });

  it("renders the reason right after the badge in the same wrapper", () => {
    render(<NotetakerStatusBadge status="FAILED" outcomeReason="NOT_ADMITTED" />);

    const badge = screen.getByTestId("notetaker-status-badge");
    const reason = screen.getByTestId("notetaker-status-reason");
    expect(badge.nextElementSibling).toBe(reason);
    expect(badge.parentElement?.children).toHaveLength(2);
  });
});
