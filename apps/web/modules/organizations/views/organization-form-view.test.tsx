import type { OrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationFormView from "./organization-form-view";

type MutationOptions = {
  onSuccess?: () => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};
type Mutation = { mutate: (input: unknown) => void; isPending: boolean };
type GetQuery = { data: OrganizationDto | undefined; isPending: boolean; error: { message: string } | null };
type OwnerRow = { id: number; email: string; username: string | null; name: string | null };

const mocks = vi.hoisted(() => ({
  createUseMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  updateUseMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  createMutate: vi.fn<(input: unknown) => void>(),
  updateMutate: vi.fn<(input: unknown) => void>(),
  getUseQuery: vi.fn<(input: { id: number }) => GetQuery>(),
  listPaginatedUseQuery:
    vi.fn<(input: unknown, options: unknown) => { data: { rows: OwnerRow[] }; isFetching: boolean }>(),
  invalidateList: vi.fn<() => Promise<void>>(),
  invalidateGet: vi.fn<(input?: unknown) => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
  push: vi.fn<(path: string) => void>(),
  replace: vi.fn<(path: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
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
          create: { useMutation: mocks.createUseMutation },
          update: { useMutation: mocks.updateUseMutation },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

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
    owners: [{ userId: 7, name: "Jane", email: "jane@acme.com" }],
    ...overrides,
  };
}

function setupMocks(getQuery?: GetQuery): void {
  mocks.createUseMutation.mockReturnValue({ mutate: mocks.createMutate, isPending: false });
  mocks.updateUseMutation.mockReturnValue({ mutate: mocks.updateMutate, isPending: false });
  mocks.listPaginatedUseQuery.mockReturnValue({ data: { rows: [OWNER] }, isFetching: false });
  mocks.invalidateList.mockResolvedValue(undefined);
  mocks.invalidateGet.mockResolvedValue(undefined);
  if (getQuery) mocks.getUseQuery.mockReturnValue(getQuery);
}

function getOptions(useMutation: typeof mocks.createUseMutation): MutationOptions {
  const options = useMutation.mock.calls[0]?.[0];
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
  fireEvent.click(screen.getByText("Jane (jane@acme.com)"));
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

    it("toasts the server message when creation fails", () => {
      setupMocks();
      render(<OrganizationFormView />);

      const { onError } = getOptions(mocks.createUseMutation);
      onError?.({ message: "User already owns another organization" });
      onError?.({ message: "Slug is already taken" });

      expect(mocks.showToast).toHaveBeenNthCalledWith(1, "User already owns another organization", "error");
      expect(mocks.showToast).toHaveBeenNthCalledWith(2, "Slug is already taken", "error");
      expect(mocks.push).not.toHaveBeenCalled();
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
      renderEdit({ data: undefined, isPending: false, error: { message: "Organization not found" } });

      expect(screen.getByText("Organization not found")).toBeInTheDocument();
    });

    it("toasts the server message when the update fails", () => {
      renderEdit({ data: buildOrg(), isPending: false, error: null });

      getOptions(mocks.updateUseMutation).onError?.({ message: "Domain is already taken" });

      expect(mocks.showToast).toHaveBeenCalledWith("Domain is already taken", "error");
      expect(mocks.push).not.toHaveBeenCalled();
    });
  });
});
