import type { TeamWithOrganizationDto } from "@calcom/lib/dto/TeamWithOrganizationDto";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminTeamsTable } from "./AdminTeamsTable";

type ListInput = { limit: number; searchTerm: string | null; organizationId: number | null };
type ListQuery = {
  data: {
    pages: { rows: TeamWithOrganizationDto[]; nextCursor?: number; meta: { totalRowCount: number } }[];
  };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  isError: boolean;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery:
    vi.fn<
      (
        input: ListInput,
        options: { getNextPageParam: (page: { nextCursor?: number }) => unknown }
      ) => ListQuery
    >(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    viewer: {
      admin: {
        teams: { listPaginated: { useInfiniteQuery: mocks.useInfiniteQuery } },
      },
    },
  },
}));

// react-select menus are hard to drive in jsdom, so the organization filter renders as a native select.
vi.mock("../../organizations/components/OrganizationSelect", () => ({
  OrganizationSelect: ({ onChange }: { value: number | null; onChange: (id: number | null) => void }) => (
    <select
      data-testid="organization-filter"
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">all</option>
      <option value="2">Acme</option>
    </select>
  ),
}));

const ACME_TEAM: TeamWithOrganizationDto = {
  id: 1,
  name: "Design",
  slug: "design",
  memberCount: 4,
  organization: { id: 2, name: "Acme" },
};
const LONE_TEAM: TeamWithOrganizationDto = {
  id: 3,
  name: "Solo",
  slug: null,
  memberCount: 1,
  organization: null,
};

function renderTable(rows: TeamWithOrganizationDto[] = [ACME_TEAM, LONE_TEAM]) {
  mocks.useInfiniteQuery.mockReturnValue({
    data: { pages: [{ rows, meta: { totalRowCount: rows.length } }] },
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPending: false,
    isError: false,
  });
  return render(<AdminTeamsTable />);
}

function lastListInput(): ListInput {
  const input = mocks.useInfiniteQuery.mock.lastCall?.[0];
  if (!input) throw new Error("useInfiniteQuery was not called");
  return input;
}

describe("AdminTeamsTable", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    mocks.useInfiniteQuery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders each team with its slug, member count and organization, falling back to none", () => {
    renderTable();

    const acmeRow = screen.getByTestId("admin-team-row-1");
    expect(acmeRow).toHaveTextContent("Design");
    expect(acmeRow).toHaveTextContent("design");
    expect(acmeRow).toHaveTextContent("4");
    expect(acmeRow).toHaveTextContent("Acme");

    const loneRow = screen.getByTestId("admin-team-row-3");
    expect(loneRow).toHaveTextContent("Solo");
    expect(loneRow).toHaveTextContent("none");
  });

  it("queries the first page unfiltered and pages by nextCursor", () => {
    renderTable();

    expect(lastListInput()).toEqual({ limit: 25, searchTerm: null, organizationId: null });
    const options = mocks.useInfiniteQuery.mock.lastCall?.[1];
    expect(options?.getNextPageParam({ nextCursor: 7 })).toBe(7);
    expect(options?.getNextPageParam({})).toBeUndefined();
  });

  it("shows the empty state when no teams match", () => {
    renderTable([]);

    expect(screen.getByTestId("admin-teams-empty")).toHaveTextContent("no_teams_found");
  });

  it("re-queries with the search term once the debounce elapses", () => {
    vi.useFakeTimers();
    renderTable();

    fireEvent.change(screen.getByPlaceholderText("admin_teams_search_placeholder"), {
      target: { value: "design" },
    });
    expect(lastListInput().searchTerm).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(lastListInput()).toEqual({ limit: 25, searchTerm: "design", organizationId: null });
  });

  it("re-queries with the chosen organization and clears it again", () => {
    renderTable();

    fireEvent.change(screen.getByTestId("organization-filter"), { target: { value: "2" } });
    expect(lastListInput()).toEqual({ limit: 25, searchTerm: null, organizationId: 2 });

    fireEvent.change(screen.getByTestId("organization-filter"), { target: { value: "" } });
    expect(lastListInput().organizationId).toBeNull();
  });
});
