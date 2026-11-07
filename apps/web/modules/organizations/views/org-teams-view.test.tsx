import type { OrganizationRoleDto, OrganizationTeamDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrgTeamsView from "./org-teams-view";

type ListInput = { search?: string; limit: number };
type ListQuery = {
  data: { pages: { items: OrganizationTeamDto[]; nextCursor?: number }[] } | undefined;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn<(input: ListInput, options: unknown) => ListQuery>(),
  fetchNextPage: vi.fn<() => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    viewer: {
      organization: {
        listTeams: { useInfiniteQuery: mocks.useInfiniteQuery },
      },
    },
  },
}));

function buildTeam(overrides: Partial<OrganizationTeamDto> = {}): OrganizationTeamDto {
  return {
    teamId: 1,
    name: "Engineering",
    slug: "engineering",
    memberCount: 7,
    viewerIsMember: false,
    ...overrides,
  };
}

function buildQuery(items: OrganizationTeamDto[], overrides: Partial<ListQuery> = {}): ListQuery {
  return {
    data: { pages: [{ items }] },
    fetchNextPage: mocks.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPending: false,
    ...overrides,
  };
}

const ENGINEERING = buildTeam({ teamId: 1, name: "Engineering", viewerIsMember: true });
const SALES = buildTeam({ teamId: 2, name: "Sales", slug: null, memberCount: 3 });

function renderView(query: ListQuery, viewerRole: OrganizationRoleDto = "MEMBER"): ReturnType<typeof render> {
  mocks.useInfiniteQuery.mockReturnValue(query);
  return render(<OrgTeamsView viewerRole={viewerRole} />);
}

describe("OrgTeamsView", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a row per team with its fields and the member badge only where the viewer is a member", () => {
    renderView(buildQuery([ENGINEERING, SALES]));

    const engineeringRow = screen.getByTestId("org-team-row-1");
    expect(within(engineeringRow).getByText("Engineering")).toBeInTheDocument();
    expect(within(engineeringRow).getByText("engineering")).toBeInTheDocument();
    expect(within(engineeringRow).getByText("7")).toBeInTheDocument();
    expect(within(engineeringRow).getByTestId("org-team-member-badge").textContent).toBe("you_are_a_member");

    const salesRow = screen.getByTestId("org-team-row-2");
    expect(within(salesRow).getByText("Sales")).toBeInTheDocument();
    expect(within(salesRow).getByText("—")).toBeInTheDocument();
    expect(within(salesRow).getByText("3")).toBeInTheDocument();
    expect(within(salesRow).queryByTestId("org-team-member-badge")).not.toBeInTheDocument();
  });

  it.each<OrganizationRoleDto>(["ADMIN", "OWNER"])("shows members and manage links to %s", (role) => {
    renderView(buildQuery([ENGINEERING, SALES]), role);

    const salesRow = screen.getByTestId("org-team-row-2");
    expect(within(salesRow).getByTestId("org-team-members-link")).toHaveAttribute(
      "href",
      "/settings/my-teams/2/members"
    );
    expect(within(salesRow).getByTestId("org-team-manage-link")).toHaveAttribute(
      "href",
      "/settings/my-teams/2/profile"
    );
    expect(screen.getAllByTestId("org-team-members-link")).toHaveLength(2);
    expect(screen.getAllByTestId("org-team-manage-link")).toHaveLength(2);
  });

  it("shows no action links to a member", () => {
    renderView(buildQuery([ENGINEERING, SALES]), "MEMBER");

    expect(screen.queryByTestId("org-team-members-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-team-manage-link")).not.toBeInTheDocument();
  });

  it("queries without a search term initially and with the debounced term after typing", () => {
    vi.useFakeTimers();
    renderView(buildQuery([ENGINEERING]));

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { search: undefined, limit: 20 },
      expect.anything()
    );

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "eng" } });
    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { search: undefined, limit: 20 },
      expect.anything()
    );

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith({ search: "eng", limit: 20 }, expect.anything());
  });

  it("shows the skeleton while the first page loads", () => {
    renderView(buildQuery([], { data: undefined, isPending: true }));

    expect(screen.getByTestId("org-teams-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("org-teams-empty")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no teams", () => {
    renderView(buildQuery([]));

    expect(screen.getByTestId("org-teams-empty").textContent).toBe("no_organization_teams_found");
  });

  it("hides load more when there is no next page", () => {
    renderView(buildQuery([ENGINEERING]));

    expect(screen.queryByText("load_more")).not.toBeInTheDocument();
  });

  it("fetches the next page when load more is clicked", () => {
    renderView(buildQuery([ENGINEERING], { hasNextPage: true }));

    fireEvent.click(screen.getByText("load_more"));

    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
