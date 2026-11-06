import type { OrganizationListItemDto } from "@calcom/lib/dto/OrganizationDto";
import type { ActionType } from "@calcom/ui/components/table";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationsListingView from "./organizations-listing-view";

type ListInput = { search?: string; limit: number };
type ListQuery = {
  data: { pages: { items: OrganizationListItemDto[]; nextCursor?: number }[] } | undefined;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  isError: boolean;
};
type MutationOptions = {
  onSuccess?: () => void;
  onError?: (error: { message: string }) => void;
  onSettled?: () => void;
};

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn<(input: ListInput, options: unknown) => ListQuery>(),
  useMutation:
    vi.fn<(options: MutationOptions) => { mutate: (input: { id: number }) => void; isPending: boolean }>(),
  mutate: vi.fn<(input: { id: number }) => void>(),
  fetchNextPage: vi.fn<() => void>(),
  invalidate: vi.fn<() => void>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below resets every hoisted mock, which would wipe a vi.fn implementation.
    useUtils: () => ({ viewer: { admin: { organizations: { list: { invalidate: mocks.invalidate } } } } }),
    viewer: {
      admin: {
        organizations: {
          list: { useInfiniteQuery: mocks.useInfiniteQuery },
          delete: { useMutation: mocks.useMutation },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

// Radix dropdown menus only open on pointer events jsdom does not emulate, so actions render as plain controls.
vi.mock("@calcom/ui/components/table", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/ui/components/table")>();
  return {
    ...actual,
    DropdownActions: ({ actions }: { actions: ActionType[] }) => (
      <div>
        {actions.map((action) =>
          action.href ? (
            <a key={action.id} href={action.href} data-testid={action.id}>
              {action.label}
            </a>
          ) : (
            <button key={action.id} type="button" data-testid={action.id} onClick={action.onClick}>
              {action.label}
            </button>
          )
        )}
      </div>
    ),
  };
});

function buildOrg(overrides: Partial<OrganizationListItemDto> = {}): OrganizationListItemDto {
  return {
    id: 1,
    name: "Acme",
    slug: "acme",
    domain: "acme.com",
    isDefault: false,
    memberCount: 12,
    teamCount: 3,
    ...overrides,
  };
}

function buildQuery(items: OrganizationListItemDto[], overrides: Partial<ListQuery> = {}): ListQuery {
  return {
    data: { pages: [{ items }] },
    fetchNextPage: mocks.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPending: false,
    isError: false,
    ...overrides,
  };
}

const DEFAULT_ORG = buildOrg({ id: 1, name: "Default", slug: null, domain: null, isDefault: true });
const ACME_ORG = buildOrg({ id: 2, name: "Acme" });

function renderView(query: ListQuery): ReturnType<typeof render> {
  mocks.useInfiniteQuery.mockReturnValue(query);
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  return render(<OrganizationsListingView />);
}

function getMutationOptions(): MutationOptions {
  const options = mocks.useMutation.mock.calls[0]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

describe("OrganizationsListingView", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a row per organization with its fields and the badge only on the default", () => {
    renderView(buildQuery([DEFAULT_ORG, ACME_ORG]));

    const defaultRow = screen.getByTestId("organization-row-1");
    expect(within(defaultRow).getByText("Default")).toBeInTheDocument();
    expect(within(defaultRow).getByTestId("organization-default-badge").textContent).toBe("default");
    expect(within(defaultRow).getAllByText("—")).toHaveLength(2);

    const acmeRow = screen.getByTestId("organization-row-2");
    expect(within(acmeRow).getByText("Acme")).toBeInTheDocument();
    expect(within(acmeRow).getByText("acme")).toBeInTheDocument();
    expect(within(acmeRow).getByText("acme.com")).toBeInTheDocument();
    expect(within(acmeRow).getByText("12")).toBeInTheDocument();
    expect(within(acmeRow).getByText("3")).toBeInTheDocument();
    expect(within(acmeRow).queryByTestId("organization-default-badge")).not.toBeInTheDocument();
    expect(within(acmeRow).getByTestId("edit")).toHaveAttribute(
      "href",
      "/settings/admin/organizations/2/edit"
    );
  });

  it("shows the empty state when there are no organizations", () => {
    renderView(buildQuery([]));

    expect(screen.getByTestId("organizations-empty").textContent).toBe("no_organizations");
  });

  it("shows the loading state while the first page loads", () => {
    renderView(buildQuery([], { data: undefined, isPending: true }));

    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByTestId("organizations-empty")).not.toBeInTheDocument();
  });

  it("shows the error state when the query fails", () => {
    renderView(buildQuery([], { data: undefined, isError: true }));

    expect(screen.getByText("something_went_wrong")).toBeInTheDocument();
  });

  it("queries without a search term initially and with the debounced term after typing", () => {
    vi.useFakeTimers();
    renderView(buildQuery([ACME_ORG]));

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith(
      { search: undefined, limit: 50 },
      expect.objectContaining({ refetchOnWindowFocus: false })
    );

    fireEvent.change(screen.getByPlaceholderText("organizations_search_placeholder"), {
      target: { value: "acme" },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mocks.useInfiniteQuery).toHaveBeenLastCalledWith({ search: "acme", limit: 50 }, expect.anything());
  });

  it("hides load more when there is no next page", () => {
    renderView(buildQuery([ACME_ORG]));

    expect(screen.queryByText("load_more_results")).not.toBeInTheDocument();
  });

  it("fetches the next page when load more is clicked", () => {
    renderView(buildQuery([ACME_ORG], { hasNextPage: true }));

    fireEvent.click(screen.getByText("load_more_results"));

    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("offers no delete action on the default organization", () => {
    renderView(buildQuery([DEFAULT_ORG, ACME_ORG]));

    expect(within(screen.getByTestId("organization-row-1")).queryByTestId("delete")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("organization-row-2")).getByTestId("delete")).toBeInTheDocument();
  });

  it("deletes the organization after confirming in the dialog", () => {
    renderView(buildQuery([DEFAULT_ORG, ACME_ORG]));

    fireEvent.click(within(screen.getByTestId("organization-row-2")).getByTestId("delete"));

    expect(screen.getByText("delete_organization")).toBeInTheDocument();
    expect(screen.getByText("delete_organization_confirmation")).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("dialog-confirmation"));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({ id: 2 });
  });

  it("toasts the server message as an error when deletion fails", () => {
    renderView(buildQuery([ACME_ORG]));

    getMutationOptions().onError?.({ message: "Organization has members" });

    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith("Organization has members", "error");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("toasts success and invalidates the list when deletion succeeds", () => {
    renderView(buildQuery([ACME_ORG]));

    getMutationOptions().onSuccess?.();

    expect(mocks.showToast).toHaveBeenCalledWith("organization_deleted_successfully", "success");
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
