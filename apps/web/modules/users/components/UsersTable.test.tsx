import type { ActionType } from "@calcom/ui/components/table";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsersTable } from "./UsersTable";

type ListInput = { limit: number; searchTerm: string; organizationId: number | null };
type UserRow = {
  id: number;
  email: string;
  username: string | null;
  name: string | null;
  timeZone: string;
  role: string;
  locked: boolean;
  organization: { id: number; name: string } | null;
};
type ListQuery = {
  data: { pages: { rows: UserRow[]; nextCursor?: number; meta: { totalRowCount: number } }[] } | undefined;
  fetchNextPage: () => void;
  isFetching: boolean;
};
type MutationOptions = {
  onSuccess?: (data?: unknown) => Promise<void> | void;
  onError?: (error: { message: string }) => void;
  onSettled?: () => void;
};
type OrganizationOption = { value: number | null; label: string };

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn<(input: ListInput, options: unknown) => ListQuery>(),
  organizationsUseQuery:
    vi.fn<
      (
        input: { limit: number },
        options: { enabled: boolean }
      ) => { data: { items: { id: number; name: string }[]; nextCursor?: number } | undefined }
    >(),
  deleteUseMutation: vi.fn<(options: MutationOptions) => { mutate: (input: { userId: number }) => void }>(),
  setInfiniteData: vi.fn<(input: ListInput, updater: unknown) => void>(),
  invalidate: vi.fn<() => void>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("@calcom/trpc/react", () => {
  // Plain functions, not vi.fn: the beforeEach below resets every hoisted mock, which would wipe a vi.fn implementation.
  const noopMutation = () => ({ mutate: () => undefined });
  return {
    trpc: {
      useUtils: () => ({
        viewer: {
          admin: {
            listPaginated: { setInfiniteData: mocks.setInfiniteData, invalidate: mocks.invalidate },
          },
        },
      }),
      viewer: {
        users: { delete: { useMutation: mocks.deleteUseMutation } },
        admin: {
          listPaginated: { useInfiniteQuery: mocks.useInfiniteQuery },
          organizations: { list: { useQuery: mocks.organizationsUseQuery } },
          sendPasswordReset: { useMutation: noopMutation },
          removeTwoFactor: { useMutation: noopMutation },
          lockUserAccount: { useMutation: noopMutation },
        },
      },
    },
  };
});

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

// react-select menus are hard to drive in jsdom, so the filter renders as a native select over the same options.
vi.mock("@calcom/ui/components/form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/ui/components/form")>();
  return {
    ...actual,
    SelectField: ({
      label,
      options,
      onChange,
    }: {
      label: string;
      options: OrganizationOption[];
      onChange: (option: OrganizationOption | null) => void;
    }) => (
      <label>
        {label}
        <select
          data-testid="organization-filter"
          onChange={(e) =>
            onChange(options.find((option) => String(option.value) === e.target.value) ?? null)
          }>
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    ),
  };
});

// Radix dropdown menus only open on pointer events jsdom does not emulate, so actions render as plain controls.
vi.mock("@calcom/ui/components/table", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/ui/components/table")>();
  return {
    ...actual,
    DropdownActions: ({ actions }: { actions: ActionType[] }) => (
      <div>
        {actions.map((action) => (
          <button key={action.id} type="button" data-testid={action.id} onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      </div>
    ),
  };
});

function buildUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 1,
    email: "alice@example.com",
    username: "alice",
    name: "Alice",
    timeZone: "Europe/Warsaw",
    role: "USER",
    locked: false,
    organization: null,
    ...overrides,
  };
}

const ACME_USER = buildUser({ id: 1, email: "alice@acme.com", organization: { id: 2, name: "Acme" } });
const LONE_USER = buildUser({ id: 3, email: "bob@example.com", username: "bob", name: "Bob" });

function renderTable(organizationsEnabled: boolean, rows: UserRow[] = [ACME_USER, LONE_USER]) {
  mocks.useInfiniteQuery.mockReturnValue({
    data: { pages: [{ rows, meta: { totalRowCount: rows.length } }] },
    fetchNextPage: () => undefined,
    isFetching: false,
  });
  mocks.organizationsUseQuery.mockReturnValue({
    data: organizationsEnabled
      ? {
          items: [
            { id: 2, name: "Acme" },
            { id: 5, name: "Globex" },
          ],
        }
      : undefined,
  });
  mocks.deleteUseMutation.mockReturnValue({ mutate: () => undefined });
  return render(<UsersTable organizationsEnabled={organizationsEnabled} />);
}

function lastListInput(): ListInput {
  const input = mocks.useInfiniteQuery.mock.lastCall?.[0];
  if (!input) throw new Error("useInfiniteQuery was not called");
  return input;
}

describe("UsersTable", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("renders no organization column or filter and skips the organizations query when disabled", () => {
    renderTable(false);

    expect(screen.queryByText("organization")).not.toBeInTheDocument();
    expect(screen.queryByTestId("organization-filter")).not.toBeInTheDocument();
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
    expect(mocks.organizationsUseQuery).toHaveBeenCalledWith({ limit: 100 }, { enabled: false });
    expect(lastListInput()).toEqual({ limit: 25, searchTerm: "", organizationId: null });
  });

  it("shows each user's organization name, or none, in the organization column when enabled", () => {
    renderTable(true);

    expect(mocks.organizationsUseQuery).toHaveBeenCalledWith({ limit: 100 }, { enabled: true });
    expect(screen.getAllByText("organization")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "none" })).toBeInTheDocument();
  });

  it("offers all organizations plus each listed organization in the filter", () => {
    renderTable(true);

    const options = Array.from(screen.getByTestId("organization-filter").querySelectorAll("option")).map(
      (option) => option.textContent
    );
    expect(options).toEqual(["all_organizations", "Acme", "Globex"]);
  });

  it("re-queries the users list with the selected organization", () => {
    renderTable(true);

    expect(lastListInput().organizationId).toBeNull();

    fireEvent.change(screen.getByTestId("organization-filter"), { target: { value: "5" } });

    expect(lastListInput()).toEqual({ limit: 25, searchTerm: "", organizationId: 5 });

    fireEvent.change(screen.getByTestId("organization-filter"), { target: { value: "null" } });

    expect(lastListInput().organizationId).toBeNull();
  });

  it("updates the cached page for the same input the list was queried with after a delete", async () => {
    renderTable(true);

    fireEvent.change(screen.getByTestId("organization-filter"), { target: { value: "2" } });

    const options = mocks.deleteUseMutation.mock.lastCall?.[0];
    if (!options) throw new Error("users.delete.useMutation was not called with options");
    await options.onSuccess?.();

    expect(mocks.setInfiniteData).toHaveBeenCalledTimes(1);
    expect(mocks.setInfiniteData.mock.calls[0]?.[0]).toBe(lastListInput());
    expect(mocks.setInfiniteData.mock.calls[0]?.[0]).toEqual({
      limit: 25,
      searchTerm: "",
      organizationId: 2,
    });
  });
});
