import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrgMembersView from "./org-members-view";

type ListInput = { search?: string; limit: number };
type ListQuery = {
  data: { pages: { items: OrganizationMemberDto[]; nextCursor?: number }[] } | undefined;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn<(input: ListInput, options: unknown) => ListQuery>(),
  fetchNextPage: vi.fn<() => void>(),
  memberActions:
    vi.fn<(props: { member: OrganizationMemberDto; viewerRole: string; viewerUserId: number }) => void>(),
}));

vi.mock("../components/org-member-actions", () => ({
  OrgMemberActions: (props: { member: OrganizationMemberDto; viewerRole: string; viewerUserId: number }) => {
    mocks.memberActions(props);
    return <span data-testid="org-member-actions" />;
  },
}));

vi.mock("../components/org-invite-member-dialog", () => ({
  OrgInviteMemberDialog: ({ open }: { open: boolean }) => (
    <div data-testid="org-invite-dialog" data-open={String(open)} />
  ),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    viewer: {
      organization: {
        listMembers: { useInfiniteQuery: mocks.useInfiniteQuery },
      },
    },
  },
}));

function buildMember(overrides: Partial<OrganizationMemberDto> = {}): OrganizationMemberDto {
  return {
    userId: 1,
    name: "Alice",
    email: "alice@acme.com",
    username: "alice",
    avatarUrl: null,
    bio: null,
    role: "MEMBER",
    accepted: true,
    ...overrides,
  };
}

function buildQuery(items: OrganizationMemberDto[], overrides: Partial<ListQuery> = {}): ListQuery {
  return {
    data: { pages: [{ items }] },
    fetchNextPage: mocks.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPending: false,
    ...overrides,
  };
}

const OWNER = buildMember({
  userId: 1,
  name: "Olivia",
  email: "olivia@acme.com",
  username: "olivia",
  role: "OWNER",
});
const PENDING_MEMBER = buildMember({
  userId: 2,
  name: null,
  email: "bob@acme.com",
  username: null,
  role: "MEMBER",
  accepted: false,
});

function renderView(query: ListQuery, viewerRole: OrganizationRoleDto = "MEMBER"): ReturnType<typeof render> {
  mocks.useInfiniteQuery.mockReturnValue(query);
  return render(<OrgMembersView viewerRole={viewerRole} viewerUserId={1} />);
}

describe("OrgMembersView", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a row per member with name, email, username and role", () => {
    renderView(buildQuery([OWNER, PENDING_MEMBER]));

    const ownerRow = screen.getByTestId("org-member-row-1");
    expect(within(ownerRow).getByText("Olivia")).toBeInTheDocument();
    expect(within(ownerRow).getByText("olivia@acme.com")).toBeInTheDocument();
    expect(within(ownerRow).getByText("olivia")).toBeInTheDocument();
    expect(within(ownerRow).getByTestId("org-member-role-badge").textContent).toBe("owner");

    const memberRow = screen.getByTestId("org-member-row-2");
    expect(within(memberRow).getByText("bob@acme.com")).toBeInTheDocument();
    expect(within(memberRow).getAllByText("—")).toHaveLength(2);
    expect(within(memberRow).getByTestId("org-member-role-badge").textContent).toBe("member");
  });

  it("shows the pending badge only for members who have not accepted", () => {
    renderView(buildQuery([OWNER, PENDING_MEMBER]));

    expect(
      within(screen.getByTestId("org-member-row-1")).queryByTestId("org-member-pending-badge")
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("org-member-row-2")).getByTestId("org-member-pending-badge").textContent
    ).toBe("pending");
  });

  it("queries without a search term initially and with the debounced term after typing", () => {
    vi.useFakeTimers();
    renderView(buildQuery([OWNER]));

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { search: undefined, limit: 20 },
      expect.anything()
    );

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "oli" } });

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { search: undefined, limit: 20 },
      expect.anything()
    );

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith({ search: "oli", limit: 20 }, expect.anything());
  });

  it("shows the loading skeleton while the first page loads", () => {
    renderView(buildQuery([], { data: undefined, isPending: true }));

    expect(screen.getByTestId("org-members-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("org-members-empty")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no members", () => {
    renderView(buildQuery([]));

    expect(screen.getByTestId("org-members-empty").textContent).toBe("no_organization_members_found");
  });

  it("renders no action buttons in the read-only list", () => {
    renderView(buildQuery([OWNER, PENDING_MEMBER]));

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("org-invite-dialog")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("org-member-actions")).toHaveLength(0);
  });

  it.each(["ADMIN", "OWNER"] as const)("lets an %s invite members and manage each row", (viewerRole) => {
    renderView(buildQuery([OWNER, PENDING_MEMBER]), viewerRole);

    expect(screen.getByTestId("org-invite-dialog").dataset.open).toBe("false");
    fireEvent.click(screen.getByText("invite_organization_member"));
    expect(screen.getByTestId("org-invite-dialog").dataset.open).toBe("true");

    expect(
      within(screen.getByTestId("org-member-row-1")).getByTestId("org-member-actions")
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("org-member-row-2")).getByTestId("org-member-actions")
    ).toBeInTheDocument();
    expect(mocks.memberActions).toHaveBeenCalledWith({ member: OWNER, viewerRole, viewerUserId: 1 });
    expect(mocks.memberActions).toHaveBeenCalledWith({ member: PENDING_MEMBER, viewerRole, viewerUserId: 1 });
  });

  it("fetches the next page when load more is clicked", () => {
    renderView(buildQuery([OWNER], { hasNextPage: true }));

    fireEvent.click(screen.getByText("load_more"));

    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
