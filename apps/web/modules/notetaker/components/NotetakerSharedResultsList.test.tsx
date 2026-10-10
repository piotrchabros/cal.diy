import type { NotetakerSharedResultDto } from "@calcom/lib/dto/NotetakerSharedResultDto";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerSharedResultsList } from "./NotetakerSharedResultsList";

type ListQuery = {
  data: { pages: { items: NotetakerSharedResultDto[]; nextCursor: string | null }[] } | undefined;
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

const mocks = vi.hoisted(() => ({
  useNotetakerSharedResults: vi.fn<() => ListQuery>(),
}));

vi.mock("../hooks/useNotetakerSharedResults", () => ({
  useNotetakerSharedResults: mocks.useNotetakerSharedResults,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

const ROW_ID = "notetaker-shared-result";
const LOAD_MORE_ID = "notetaker-shared-load-more";

function buildItem(overrides: Partial<NotetakerSharedResultDto> = {}): NotetakerSharedResultDto {
  return {
    bookingUid: "booking-1",
    title: "Weekly sync",
    startTime: "2026-03-04T10:15:00.000Z",
    eventTypeTitle: "Sync",
    teamName: "Team A",
    hostName: "Alice",
    route: "TEAM",
    summaryStatus: null,
    ...overrides,
  };
}

function buildQuery(overrides: Partial<ListQuery> = {}): ListQuery {
  return {
    data: { pages: [{ items: [buildItem()], nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...overrides,
  };
}

function renderList(query: ListQuery): ReturnType<typeof render> {
  mocks.useNotetakerSharedResults.mockReturnValue(query);
  return render(<NotetakerSharedResultsList />);
}

describe("NotetakerSharedResultsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing while loading and on error", () => {
    renderList(buildQuery({ data: undefined, isPending: true }));
    expect(screen.queryByTestId(ROW_ID)).toBeNull();
    expect(screen.queryByText("notetaker_shared_with_me_empty_title")).toBeNull();
  });

  it("renders nothing on error", () => {
    renderList(buildQuery({ data: undefined, isError: true }));
    expect(screen.queryByText("notetaker_shared_with_me_empty_title")).toBeNull();
  });

  it("links each row to the results page and shows its details", () => {
    renderList(buildQuery());

    const row = screen.getByTestId(ROW_ID);
    expect(row.getAttribute("href")).toBe("/booking/booking-1/notetaker");
    expect(row.textContent).toContain("Weekly sync");
    expect(row.textContent).toContain("Sync");
    expect(row.textContent).toContain('notetaker_shared_with_me_host:{"name":"Alice"}');
    expect(row.textContent).toContain(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date("2026-03-04T10:15:00.000Z")
      )
    );
  });

  it("describes the team route and the selected people route", () => {
    renderList(
      buildQuery({
        data: {
          pages: [
            {
              items: [
                buildItem({ bookingUid: "b1", route: "TEAM", teamName: "Team A" }),
                buildItem({ bookingUid: "b2", route: "SELECTED_PEOPLE" }),
              ],
              nextCursor: null,
            },
          ],
        },
      })
    );

    const rows = screen.getAllByTestId(ROW_ID);
    expect(rows[0]?.textContent).toContain('notetaker_shared_with_me_route_team:{"teamName":"Team A"}');
    expect(rows[1]?.textContent).toContain("notetaker_shared_with_me_route_selected_people");
  });

  it("omits the host line when the host is unknown", () => {
    renderList(
      buildQuery({ data: { pages: [{ items: [buildItem({ hostName: null })], nextCursor: null }] } })
    );

    expect(screen.getByTestId(ROW_ID).textContent).not.toContain("notetaker_shared_with_me_host");
  });

  it("lists the rows of every loaded page", () => {
    renderList(
      buildQuery({
        data: {
          pages: [
            { items: [buildItem({ bookingUid: "b1" })], nextCursor: "c1" },
            { items: [buildItem({ bookingUid: "b2" })], nextCursor: null },
          ],
        },
      })
    );

    expect(screen.getAllByTestId(ROW_ID)).toHaveLength(2);
  });

  it("shows the empty screen when nothing is shared and no page follows", () => {
    renderList(buildQuery({ data: { pages: [{ items: [], nextCursor: null }] } }));

    expect(screen.getByText("notetaker_shared_with_me_empty_title")).toBeTruthy();
    expect(screen.getByText("notetaker_shared_with_me_empty_description")).toBeTruthy();
    expect(screen.queryByTestId(LOAD_MORE_ID)).toBeNull();
  });

  it("offers load more when a page follows and fetches it on click", () => {
    const fetchNextPage = vi.fn();
    renderList(buildQuery({ hasNextPage: true, fetchNextPage }));

    fireEvent.click(screen.getByTestId(LOAD_MORE_ID));

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("offers load more instead of the empty screen when an empty page has a cursor", () => {
    renderList(buildQuery({ data: { pages: [{ items: [], nextCursor: "c1" }] }, hasNextPage: true }));

    expect(screen.getByTestId(LOAD_MORE_ID)).toBeTruthy();
    expect(screen.queryByText("notetaker_shared_with_me_empty_title")).toBeNull();
  });

  it("hides load more on the last page", () => {
    renderList(buildQuery({ hasNextPage: false }));

    expect(screen.queryByTestId(LOAD_MORE_ID)).toBeNull();
  });
});
