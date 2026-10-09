import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotetakerTranscript } from "./NotetakerTranscript";

// The shared setup's `t` drops interpolation values; this makes the formatted time observable.
vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

type PassagesPage = { passages: NotetakerPassageDto[]; nextCursor: number | null };
type PassagesQueryResult = {
  data: { pages: PassagesPage[] } | undefined;
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery:
    vi.fn<(input: { bookingUid: string; sessionId?: string }, options: unknown) => PassagesQueryResult>(),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { notetaker: { listPassages: { useInfiniteQuery: mocks.useInfiniteQuery } } } },
}));

const MARKER_ID = "notetaker-interruption-marker";
const PASSAGE_ID = "notetaker-passage";

function buildPassage(
  index: number,
  startMs: number,
  overrides: Partial<NotetakerPassageDto> = {}
): NotetakerPassageDto {
  return {
    index,
    speakerName: "Ada",
    unknownSpeakerNumber: null,
    startMs,
    endMs: startMs + 1000,
    text: `passage ${index}`,
    language: "en",
    ...overrides,
  };
}

function buildQueryResult(
  pages: NotetakerPassageDto[][],
  overrides: Partial<PassagesQueryResult> = {}
): PassagesQueryResult {
  return {
    data: { pages: pages.map((passages) => ({ passages, nextCursor: null })) },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => undefined,
    ...overrides,
  };
}

function buildStandardPassages(): NotetakerPassageDto[] {
  return [buildPassage(0, 0), buildPassage(1, 30000), buildPassage(2, 65000)];
}

function renderTranscript(result: PassagesQueryResult, props: { interruptedAtMs?: number | null } = {}) {
  mocks.useInfiniteQuery.mockReturnValue(result);
  render(<NotetakerTranscript bookingUid="uid-1" {...props} />);
}

function listItemTestIds(): (string | null)[] {
  return within(screen.getByTestId("notetaker-transcript"))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-testid"));
}

describe("NotetakerTranscript interruption marker", () => {
  it("places the marker before the first passage starting at or after the interruption", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), { interruptedAtMs: 40000 });

    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, MARKER_ID, PASSAGE_ID]);
    expect(screen.getByTestId(MARKER_ID)).toHaveTextContent('notetaker_interrupted_at:{"time":"0:40"}');
  });

  it("places the marker before a passage whose start equals the interruption", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), { interruptedAtMs: 30000 });

    expect(listItemTestIds()).toEqual([PASSAGE_ID, MARKER_ID, PASSAGE_ID, PASSAGE_ID]);
  });

  it("places the marker first when the interruption is at zero", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), { interruptedAtMs: 0 });

    expect(listItemTestIds()).toEqual([MARKER_ID, PASSAGE_ID, PASSAGE_ID, PASSAGE_ID]);
  });

  it("appends the marker after the last passage when none qualifies and no more pages exist", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), { interruptedAtMs: 100000 });

    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, PASSAGE_ID, MARKER_ID]);
    expect(screen.getByTestId(MARKER_ID)).toHaveTextContent('notetaker_interrupted_at:{"time":"1:40"}');
  });

  it("renders no marker yet when none qualifies and more pages exist", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()], { hasNextPage: true }), {
      interruptedAtMs: 100000,
    });

    expect(screen.queryByTestId(MARKER_ID)).not.toBeInTheDocument();
    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, PASSAGE_ID]);
    expect(screen.getByRole("button", { name: "notetaker_load_more_passages" })).toBeInTheDocument();
  });

  it("shows the marker when a loaded passage qualifies even though more pages exist", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()], { hasNextPage: true }), {
      interruptedAtMs: 40000,
    });

    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, MARKER_ID, PASSAGE_ID]);
  });

  it("places the marker before the first passage of a later page", () => {
    renderTranscript(
      buildQueryResult([[buildPassage(0, 0), buildPassage(1, 30000)], [buildPassage(2, 65000)]]),
      {
        interruptedAtMs: 40000,
      }
    );

    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, MARKER_ID, PASSAGE_ID]);
    expect(screen.getAllByTestId(MARKER_ID)).toHaveLength(1);
  });

  it.each([
    { label: "null", props: { interruptedAtMs: null } },
    { label: "omitted", props: {} },
  ])("renders no marker when interruptedAtMs is $label", ({ props }) => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), props);

    expect(screen.queryByTestId(MARKER_ID)).not.toBeInTheDocument();
    expect(listItemTestIds()).toEqual([PASSAGE_ID, PASSAGE_ID, PASSAGE_ID]);
  });

  it("formats times of an hour or more with hours", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]), { interruptedAtMs: 3_725_000 });

    expect(screen.getByTestId(MARKER_ID)).toHaveTextContent('notetaker_interrupted_at:{"time":"1:02:05"}');
  });

  it("renders only the empty text, without a marker, when there are no passages", () => {
    renderTranscript(buildQueryResult([[]]), { interruptedAtMs: 5000 });

    expect(screen.getByText("notetaker_transcript_empty")).toBeInTheDocument();
    expect(screen.queryByTestId(MARKER_ID)).not.toBeInTheDocument();
    expect(screen.queryByTestId("notetaker-transcript")).not.toBeInTheDocument();
  });

  it("queries passages for the booking without a session id by default", () => {
    renderTranscript(buildQueryResult([buildStandardPassages()]));

    expect(mocks.useInfiniteQuery.mock.calls[0]?.[0]).toEqual({ bookingUid: "uid-1", sessionId: undefined });
  });
});
