import type {
  NotetakerSharedResultDto,
  NotetakerSharedResultsDto,
} from "@calcom/lib/dto/NotetakerSharedResultDto";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerSharedNotesLink } from "./NotetakerSharedNotesLink";

type LinkQuery = { data: NotetakerSharedResultsDto | undefined };

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(input: { limit: number }, options: { retry: boolean; staleTime: number }) => LinkQuery>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: { viewer: { notetaker: { listSharedWithMe: { useQuery: mocks.useQuery } } } },
}));

const LINK_ID = "notetaker-shared-notes-link";

const ITEM: NotetakerSharedResultDto = {
  bookingUid: "booking-1",
  title: "Weekly sync",
  startTime: "2026-03-04T10:15:00.000Z",
  eventTypeTitle: "Sync",
  teamName: "Team",
  hostName: "Alice",
  route: "TEAM",
  summaryStatus: null,
};

describe("NotetakerSharedNotesLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for a single item and caches the answer", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    render(<NotetakerSharedNotesLink />);

    expect(mocks.useQuery).toHaveBeenCalledWith({ limit: 1 }, { retry: false, staleTime: 5 * 60 * 1000 });
  });

  it("renders nothing while loading or after an error", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    render(<NotetakerSharedNotesLink />);

    expect(screen.queryByTestId(LINK_ID)).toBeNull();
  });

  it("renders nothing when nothing is shared", () => {
    mocks.useQuery.mockReturnValue({ data: { items: [], nextCursor: null } });
    render(<NotetakerSharedNotesLink />);

    expect(screen.queryByTestId(LINK_ID)).toBeNull();
  });

  it("links to the shared notes page when the page has an item", () => {
    mocks.useQuery.mockReturnValue({ data: { items: [ITEM], nextCursor: null } });
    render(<NotetakerSharedNotesLink />);

    const link = screen.getByTestId(LINK_ID);
    expect(link.getAttribute("href")).toBe("/bookings/shared-notes");
    expect(link.textContent).toBe("notetaker_shared_with_me_link");
  });

  it("links when the page is empty but more may follow", () => {
    mocks.useQuery.mockReturnValue({ data: { items: [], nextCursor: "cursor-1" } });
    render(<NotetakerSharedNotesLink />);

    expect(screen.getByTestId(LINK_ID)).toBeTruthy();
  });
});
