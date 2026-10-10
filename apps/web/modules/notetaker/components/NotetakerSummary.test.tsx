import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotetakerSummary } from "./NotetakerSummary";

// The shared setup's `t` drops interpolation values; this makes the owner name observable.
vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

function buildSummary(overrides: Partial<NotetakerSummaryDto> = {}): NotetakerSummaryDto {
  return {
    status: "READY",
    language: "en",
    generatedAt: "2026-01-01T10:00:00.000Z",
    overview: "The team agreed the launch plan.",
    keyPoints: ["Launch is in March", "Budget is approved"],
    decisions: ["Ship the beta first"],
    actionItems: [
      { text: "Send the notes", owner: "Ada" },
      { text: "Book the room", owner: null },
    ],
    ...overrides,
  };
}

function buildEmptySummary(status: "PENDING" | "NOT_ENOUGH_CONTENT" | "FAILED"): NotetakerSummaryDto {
  return buildSummary({ status, overview: null, keyPoints: [], decisions: [], actionItems: [] });
}

function renderSummary(props: Partial<Parameters<typeof NotetakerSummary>[0]> = {}) {
  const onRegenerate = vi.fn();
  render(
    <NotetakerSummary
      summary={buildSummary()}
      viewerRole="HOST"
      onRegenerate={onRegenerate}
      isRegenerating={false}
      {...props}
    />
  );
  return { onRegenerate: props.onRegenerate ?? onRegenerate };
}

describe("NotetakerSummary", () => {
  it("renders the full READY summary without a regenerate button", () => {
    renderSummary();

    expect(screen.getByTestId("notetaker-summary")).toBeInTheDocument();
    for (const name of [
      "notetaker_summary_overview",
      "notetaker_summary_key_points",
      "notetaker_summary_decisions",
      "notetaker_summary_action_items",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("The team agreed the launch plan.")).toBeInTheDocument();

    const items = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    for (const text of [
      "Launch is in March",
      "Budget is approved",
      "Ship the beta first",
      "Send the notes",
      "Book the room",
    ]) {
      expect(items.some((item) => item.includes(text))).toBe(true);
    }

    expect(
      screen.getByText('notetaker_summary_owner {"name":"Ada","interpolation":{"escapeValue":false}}')
    ).toBeInTheDocument();
    expect(screen.getAllByText(/notetaker_summary_owner/)).toHaveLength(1);
    expect(screen.queryByTestId("notetaker-summary-regenerate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-summary-failed")).not.toBeInTheDocument();
  });

  it("hides the decisions heading when there are no decisions", () => {
    renderSummary({ summary: buildSummary({ decisions: [] }) });

    expect(screen.queryByRole("heading", { name: "notetaker_summary_decisions" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "notetaker_summary_key_points" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "notetaker_summary_action_items" })).toBeInTheDocument();
  });

  it("renders only the overview heading when all lists are empty", () => {
    renderSummary({ summary: buildSummary({ keyPoints: [], decisions: [], actionItems: [] }) });

    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("renders the pending message without a button", () => {
    renderSummary({ summary: buildEmptySummary("PENDING") });

    expect(screen.getByTestId("notetaker-summary-pending")).toHaveTextContent("notetaker_summary_pending");
    expect(screen.queryByTestId("notetaker-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-summary-regenerate")).not.toBeInTheDocument();
  });

  it("renders the not-enough-content message without a button", () => {
    renderSummary({ summary: buildEmptySummary("NOT_ENOUGH_CONTENT") });

    expect(screen.getByTestId("notetaker-summary-not-enough-content")).toHaveTextContent(
      "notetaker_summary_not_enough_content"
    );
    expect(screen.queryByTestId("notetaker-summary-regenerate")).not.toBeInTheDocument();
  });

  it("lets the host regenerate a failed summary", () => {
    const { onRegenerate } = renderSummary({ summary: buildEmptySummary("FAILED") });

    expect(screen.getByTestId("notetaker-summary-failed")).toHaveTextContent("notetaker_summary_failed");
    const button = screen.getByTestId("notetaker-summary-regenerate");
    expect(button).toHaveTextContent("notetaker_summary_regenerate");
    expect(button).toBeEnabled();

    fireEvent.click(button);

    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("hides the regenerate button from attendees on a failed summary", () => {
    renderSummary({ summary: buildEmptySummary("FAILED"), viewerRole: "ATTENDEE" });

    expect(screen.getByTestId("notetaker-summary-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-summary-regenerate")).not.toBeInTheDocument();
  });

  it("treats a missing summary as failed for the host", () => {
    renderSummary({ summary: null });

    expect(screen.getByTestId("notetaker-summary-failed")).toBeInTheDocument();
    expect(screen.getByTestId("notetaker-summary-regenerate")).toBeInTheDocument();
  });

  it("treats a missing summary as failed for an attendee without a button", () => {
    renderSummary({ summary: null, viewerRole: "ATTENDEE" });

    expect(screen.getByTestId("notetaker-summary-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-summary-regenerate")).not.toBeInTheDocument();
  });

  it("disables the regenerate button while regenerating", () => {
    const { onRegenerate } = renderSummary({ summary: buildEmptySummary("FAILED"), isRegenerating: true });

    const button = screen.getByTestId("notetaker-summary-regenerate");
    expect(button).toBeDisabled();

    fireEvent.click(button);

    expect(onRegenerate).not.toHaveBeenCalled();
  });
});
