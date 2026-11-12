import type { OrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationFormView from "./organization-form-view";

type MutationOptions = {
  onSuccess?: (
    data?: unknown,
    variables?: { owner: { userId: number } | { email: string } }
  ) => Promise<void> | void;
  onError?: (error: { message: string; data?: { code: string } }) => void;
};
type Mutation = { mutate: (input: unknown) => void; isPending: boolean };
type GetQuery = { data: OrganizationDto | undefined; isPending: boolean; error: { message: string } | null };
type OwnerRow = { id: number; email: string; username: string | null; name: string | null };
type TeamRow = {
  teamId: number;
  name: string;
  slug: string | null;
  memberCount: number;
  viewerIsMember: boolean;
};
type ListTeamsQuery = {
  data: { pages: { items: TeamRow[] }[] };
  isPending: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

const mocks = vi.hoisted(() => ({
  createUseMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  updateUseMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  createMutate: vi.fn<(input: unknown) => void>(),
  updateMutate: vi.fn<(input: unknown) => void>(),
  demoteUseMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  demoteMutate: vi.fn<(input: unknown) => void>(),
  getUseQuery: vi.fn<(input: { id: number }) => GetQuery>(),
  listPaginatedUseQuery:
    vi.fn<(input: unknown, options: unknown) => { data: { rows: OwnerRow[] }; isFetching: boolean }>(),
  listTeamsUseInfiniteQuery: vi.fn<(input: unknown, options: unknown) => ListTeamsQuery>(),
  invalidateList: vi.fn<() => Promise<void>>(),
  invalidateGet: vi.fn<(input?: unknown) => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
  push: vi.fn<(path: string) => void>(),
  replace: vi.fn<(path: string) => void>(),
}));

// Service error keys get a distinct translation so the tests prove the views pass them through t()
const ERROR_TRANSLATIONS: Record<string, string> = {
  organization_not_found: "Organization not found",
  organization_domain_taken: "Organization domain is already taken",
  organization_owner_needs_username: "The owner needs a username",
  organization_must_keep_one_owner: "An organization must keep at least one owner",
};

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => ERROR_TRANSLATIONS[key] ?? key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    // A plain function, not vi.fn: the beforeEach below resets every hoisted mock, which would wipe a vi.fn implementation.
    useUtils: () => ({
      viewer: {
        admin: {
          organizations: {
            list: { invalidate: mocks.invalidateList },
            get: { invalidate: mocks.invalidateGet },
          },
        },
      },
    }),
    viewer: {
      admin: {
        listPaginated: { useQuery: mocks.listPaginatedUseQuery },
        organizations: {
          get: { useQuery: mocks.getUseQuery },
          listTeams: { useInfiniteQuery: mocks.listTeamsUseInfiniteQuery },
          create: { useMutation: mocks.createUseMutation },
          update: { useMutation: mocks.updateUseMutation },
          demoteOwner: { useMutation: mocks.demoteUseMutation },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  ConfirmationDialogContent: ({ children, onConfirm }: { children: ReactNode; onConfirm: () => void }) => (
    <div role="dialog">
      {children}
      <button type="button" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));

const OWNER: OwnerRow = { id: 7, email: "jane@acme.com", username: "jane", name: "Jane" };

function buildOrg(overrides: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    id: 2,
    name: "Acme",
    slug: "acme",
    domain: "acme.com",
    isDefault: false,
    memberCount: 4,
    teamCount: 1,
    logoUrl: null,
    owners: [{ userId: 7, name: "Jane", email: "jane@acme.com" }],
    ...overrides,
  };
}

function setupMocks(getQuery?: GetQuery): void {
  mocks.createUseMutation.mockReturnValue({ mutate: mocks.createMutate, isPending: false });
  mocks.updateUseMutation.mockReturnValue({ mutate: mocks.updateMutate, isPending: false });
  mocks.demoteUseMutation.mockReturnValue({ mutate: mocks.demoteMutate, isPending: false });
  mocks.listPaginatedUseQuery.mockReturnValue({ data: { rows: [OWNER] }, isFetching: false });
  mocks.listTeamsUseInfiniteQuery.mockReturnValue({
    data: {
      pages: [
        { items: [{ teamId: 5, name: "Sales", slug: "sales", memberCount: 3, viewerIsMember: false }] },
      ],
    },
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
  mocks.invalidateList.mockResolvedValue(undefined);
  mocks.invalidateGet.mockResolvedValue(undefined);
  if (getQuery) mocks.getUseQuery.mockReturnValue(getQuery);
}

// The edit view renders two update mutations: the form's first, then the add-owner section's.
function getOptions(useMutation: typeof mocks.createUseMutation, callIndex = 0): MutationOptions {
  const options = useMutation.mock.calls[callIndex]?.[0];
  if (!options) throw new Error("useMutation was not called with options");
  return options;
}

function fillBasicFields(): void {
  fireEvent.change(screen.getByLabelText("name"), { target: { value: "Acme" } });
  fireEvent.change(screen.getByLabelText("slug"), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText("domain"), { target: { value: "acme.com" } });
}

function pickOwner(): void {
  const input = screen.getByLabelText("owner");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Jane (jane@acme.com)" }));
}

function renderEdit(getQuery: GetQuery): void {
  setupMocks(getQuery);
  render(<OrganizationFormView organizationId={2} />);
}

describe("OrganizationFormView", () => {
  // The root vitest config does not load the modules setup that resets mocks, so call history would otherwise leak between tests.
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  describe("create", () => {
    it("submits the fields and the picked owner", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      pickOwner();
      fireEvent.click(screen.getByText("create"));

      await waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));
      expect(mocks.createMutate).toHaveBeenCalledWith({
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        owner: { userId: 7 },
      });
    });

    it("requires an owner before submitting", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      fireEvent.click(screen.getByText("create"));

      expect(await screen.findByText("organization_owner_required")).toBeInTheDocument();
      expect(mocks.createMutate).not.toHaveBeenCalled();
    });

    it("toasts the translated server message when creation fails", () => {
      setupMocks();
      render(<OrganizationFormView />);

      const { onError } = getOptions(mocks.createUseMutation);
      onError?.({ message: "organization_slug_taken" });
      onError?.({ message: "owner_in_another_organization", data: { code: "CONFLICT" } });

      expect(mocks.showToast).toHaveBeenNthCalledWith(1, "organization_slug_taken", "error");
      expect(mocks.showToast).toHaveBeenNthCalledWith(2, "owner_in_another_organization", "error");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it("asks to move an owner from another organization and resubmits with confirmMoveOwner", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      pickOwner();
      fireEvent.click(screen.getByText("create"));
      await waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));

      act(() =>
        getOptions(mocks.createUseMutation).onError?.({
          message: "owner_in_another_organization",
          data: { code: "PRECONDITION_FAILED" },
        })
      );

      expect(screen.getByRole("dialog")).toHaveTextContent("owner_in_another_organization_confirm_move");
      expect(mocks.showToast).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "confirm" }));

      expect(mocks.createMutate).toHaveBeenLastCalledWith({
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        owner: { userId: 7 },
        confirmMoveOwner: true,
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("submits an email owner without an owner pick", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      fireEvent.click(screen.getByText("organization_owner_invite_by_email"));
      fireEvent.change(screen.getByLabelText("organization_owner_email"), {
        target: { value: " new@acme.com " },
      });
      fireEvent.click(screen.getByText("create"));

      await waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));
      expect(mocks.createMutate).toHaveBeenCalledWith({
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        owner: { email: "new@acme.com" },
      });

      await getOptions(mocks.createUseMutation).onSuccess?.(undefined, { owner: { email: "new@acme.com" } });
      expect(mocks.showToast).toHaveBeenCalledWith("organization_created_owner_invited", "success");
    });

    it("requires an email in email mode", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      fireEvent.click(screen.getByText("organization_owner_invite_by_email"));
      fireEvent.click(screen.getByText("create"));

      expect(await screen.findByText("organization_owner_email_required")).toBeInTheDocument();
      expect(mocks.createMutate).not.toHaveBeenCalled();
    });

    it("requires an owner again after switching back to an existing user", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      fillBasicFields();
      fireEvent.click(screen.getByText("organization_owner_invite_by_email"));
      fireEvent.click(screen.getByText("organization_owner_existing_user"));
      fireEvent.click(screen.getByText("create"));

      expect(await screen.findByText("organization_owner_required")).toBeInTheDocument();
      expect(mocks.createMutate).not.toHaveBeenCalled();
    });

    it("does not render the teams section", () => {
      setupMocks();
      render(<OrganizationFormView />);

      expect(screen.queryByTestId("organization-teams-section")).not.toBeInTheDocument();
      expect(mocks.listTeamsUseInfiniteQuery).not.toHaveBeenCalled();
    });

    it("toasts, invalidates the list and navigates back on success", async () => {
      setupMocks();
      render(<OrganizationFormView />);

      await getOptions(mocks.createUseMutation).onSuccess?.();

      expect(mocks.showToast).toHaveBeenCalledWith("organization_created_successfully", "success");
      expect(mocks.invalidateList).toHaveBeenCalledTimes(1);
      expect(mocks.push).toHaveBeenCalledWith("/settings/admin/organizations");
    });
  });

  describe("edit", () => {
    it("loads the organization into the form without a domain warning", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      expect(mocks.getUseQuery).toHaveBeenCalledWith({ id: 2 });
      expect(screen.getByLabelText("name")).toHaveValue("Acme");
      expect(screen.getByLabelText("slug")).toHaveValue("acme");
      expect(screen.getByLabelText("domain")).toHaveValue("acme.com");
      expect(screen.getByText("Jane (jane@acme.com)")).toBeInTheDocument();
      expect(screen.queryByTestId("organization-domain-warning")).not.toBeInTheDocument();
    });

    it("lists the organization's teams below the form", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      expect(screen.getByTestId("organization-teams-section")).toBeInTheDocument();
      expect(mocks.listTeamsUseInfiniteQuery.mock.calls[0]?.[0]).toEqual({
        organizationId: 2,
        search: undefined,
        limit: 50,
      });
      expect(screen.getByTestId("organization-team-row-5")).toHaveTextContent("Sales");
    });

    it("warns when the domain changes", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      fireEvent.change(screen.getByLabelText("domain"), { target: { value: "cal.acme.com" } });

      expect(screen.getByTestId("organization-domain-warning")).toBeInTheDocument();
    });

    it("submits only the changed fields", async () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      fireEvent.change(screen.getByLabelText("name"), { target: { value: "Acme Inc" } });
      fireEvent.click(screen.getByText("save"));

      await waitFor(() => expect(mocks.updateMutate).toHaveBeenCalledTimes(1));
      expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 2, name: "Acme Inc" });
    });

    it("disables the domain of the default organization", () => {
      renderEdit({
        data: buildOrg({ id: 1, name: "Default", slug: null, domain: null, isDefault: true }),
        isPending: false,
        error: null,
      });

      expect(screen.getByLabelText("domain")).toBeDisabled();
      expect(screen.getByText("organization_default_domain_locked")).toBeInTheDocument();
    });

    it("shows the loading state while the organization loads", () => {
      renderEdit({ data: undefined, isPending: true, error: null });

      expect(screen.getByText("loading")).toBeInTheDocument();
    });

    it("shows the error message when the organization fails to load", () => {
      renderEdit({ data: undefined, isPending: false, error: { message: "organization_not_found" } });

      expect(screen.getByText("Organization not found")).toBeInTheDocument();
    });

    it("toasts the translated server message when the update fails", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      getOptions(mocks.updateUseMutation).onError?.({ message: "organization_domain_taken" });

      expect(mocks.showToast).toHaveBeenCalledWith("Organization domain is already taken", "error");
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it("adds an owner, toasts and invalidates without navigating", async () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      const addButton = screen.getByRole("button", { name: "organization_add_owner" });
      expect(addButton).toBeDisabled();
      pickOwner();
      fireEvent.click(addButton);

      expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 2, ownerUserId: 7 });

      await act(async () => {
        await getOptions(mocks.updateUseMutation, 1).onSuccess?.();
      });

      expect(mocks.showToast).toHaveBeenCalledWith("organization_owner_added", "success");
      expect(mocks.invalidateGet).toHaveBeenCalledWith({ id: 2 });
      expect(mocks.invalidateList).toHaveBeenCalledTimes(1);
      expect(mocks.push).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "organization_add_owner" })).toBeDisabled();
    });

    it("toasts the translated server message when adding an owner fails", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      const { onError } = getOptions(mocks.updateUseMutation, 1);
      onError?.({ message: "owner_in_another_organization", data: { code: "CONFLICT" } });
      onError?.({ message: "organization_owner_needs_username" });

      expect(mocks.showToast).toHaveBeenNthCalledWith(1, "owner_in_another_organization", "error");
      expect(mocks.showToast).toHaveBeenNthCalledWith(2, "The owner needs a username", "error");
    });

    describe("owner list", () => {
      const TWO_OWNERS = [
        { userId: 7, name: "Jane", email: "jane@acme.com" },
        { userId: 8, name: null, email: "joe@acme.com" },
      ];

      it("offers no demotion for the only owner", () => {
        renderEdit({ data: buildOrg(), isPending: false, error: null });

        expect(screen.getByText("Jane (jane@acme.com)")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "organization_make_admin" })).not.toBeInTheDocument();
      });

      it("demotes one of several owners to the chosen role", () => {
        renderEdit({ data: buildOrg({ owners: TWO_OWNERS }), isPending: false, error: null });

        const rows = screen.getAllByTestId("organization-owner");
        expect(rows[1]).toHaveTextContent("joe@acme.com (joe@acme.com)");
        fireEvent.click(within(rows[1]).getByRole("button", { name: "organization_make_member" }));
        fireEvent.click(within(rows[0]).getByRole("button", { name: "organization_make_admin" }));

        expect(mocks.demoteMutate).toHaveBeenNthCalledWith(1, { id: 2, userId: 8, role: "MEMBER" });
        expect(mocks.demoteMutate).toHaveBeenNthCalledWith(2, { id: 2, userId: 7, role: "ADMIN" });
      });

      it("toasts and refreshes the organization after a demotion", async () => {
        renderEdit({ data: buildOrg({ owners: TWO_OWNERS }), isPending: false, error: null });

        await act(async () => {
          await getOptions(mocks.demoteUseMutation).onSuccess?.();
        });

        expect(mocks.showToast).toHaveBeenCalledWith("organization_owner_demoted", "success");
        expect(mocks.invalidateGet).toHaveBeenCalledWith({ id: 2 });
        expect(mocks.invalidateList).toHaveBeenCalledTimes(1);
      });

      it("toasts the translated refusal when the demotion fails", () => {
        renderEdit({ data: buildOrg({ owners: TWO_OWNERS }), isPending: false, error: null });

        getOptions(mocks.demoteUseMutation).onError?.({ message: "organization_must_keep_one_owner" });

        expect(mocks.showToast).toHaveBeenCalledWith("An organization must keep at least one owner", "error");
      });
    });
  });
});
