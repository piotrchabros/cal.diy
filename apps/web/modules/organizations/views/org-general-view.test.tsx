import type { CurrentOrganizationDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrgGeneralView from "./org-general-view";

type MutationOptions = {
  onSuccess?: (data: { name: string }) => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};
type Mutation = { mutate: (input: { name: string }) => void; isPending: boolean };

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn<(options: MutationOptions) => Mutation>(),
  mutate: vi.fn<(input: { name: string }) => void>(),
  invalidateCurrent: vi.fn<() => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

// Service error keys get a distinct translation so the tests prove the view passes them through t()
const ERROR_TRANSLATIONS: Record<string, string> = {
  organization_name_updated: "Organization name updated",
  organization_name_invalid: "Organization name must be between 1 and 100 characters",
  organization_only_managers_can_update_organization:
    "Only organization owners and admins can update the organization",
};

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => ERROR_TRANSLATIONS[key] ?? key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: { organization: { current: { invalidate: mocks.invalidateCurrent } } },
    }),
    viewer: {
      organization: {
        updateName: { useMutation: mocks.useMutation },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("../components/OrganizationNotetakerBotSection", () => ({
  OrganizationNotetakerBotSection: () => <div data-testid="notetaker-bot-section" />,
}));

function buildOrg(viewerRole: OrganizationRoleDto): CurrentOrganizationDto {
  return {
    id: 5,
    name: "Acme",
    slug: "acme",
    domain: "acme.example.com",
    isDefault: false,
    owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
    viewerRole,
  };
}

function renderView(
  viewerRole: OrganizationRoleDto = "OWNER",
  notetakerEnabled = false
): ReturnType<typeof render> {
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.invalidateCurrent.mockResolvedValue(undefined);
  return render(<OrgGeneralView organization={buildOrg(viewerRole)} notetakerEnabled={notetakerEnabled} />);
}

function getMutationOptions(callIndex = 0): MutationOptions {
  return mocks.useMutation.mock.calls[callIndex][0];
}

describe("OrgGeneralView", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it.each(["OWNER", "ADMIN"] as const)("lets an %s rename the organization", (viewerRole) => {
    renderView(viewerRole);

    expect(screen.getByTestId("org-general-name-input")).toHaveValue("Acme");
    expect(screen.getByTestId("org-general-name-input")).toBeEnabled();
    expect(screen.getByTestId("org-general-save-button")).toBeInTheDocument();
  });

  it("shows slug and domain read-only with the instance-admin note", () => {
    renderView("ADMIN");

    expect(screen.getByTestId("org-general-slug-input")).toHaveValue("acme");
    expect(screen.getByTestId("org-general-slug-input")).toBeDisabled();
    expect(screen.getByTestId("org-general-domain-input")).toHaveValue("acme.example.com");
    expect(screen.getByTestId("org-general-domain-input")).toBeDisabled();
    expect(screen.getByTestId("org-general-locked-note").textContent).toBe(
      "organization_profile_locked_note"
    );
  });

  it("renders the notetaker bot section only when the notetaker feature is enabled", () => {
    const { unmount } = renderView("OWNER", true);
    expect(screen.getByTestId("notetaker-bot-section")).toBeInTheDocument();
    unmount();

    renderView("OWNER", false);
    expect(screen.queryByTestId("notetaker-bot-section")).not.toBeInTheDocument();
  });

  it("renders placeholders when slug or domain are not set", () => {
    const organization = { ...buildOrg("OWNER"), slug: null, domain: null };
    mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
    mocks.invalidateCurrent.mockResolvedValue(undefined);
    render(<OrgGeneralView organization={organization} notetakerEnabled={false} />);

    expect(screen.getByTestId("org-general-slug-input")).toHaveValue("—");
    expect(screen.getByTestId("org-general-domain-input")).toHaveValue("—");
  });

  it("renders a read-only profile without a save button for a MEMBER", () => {
    renderView("MEMBER");

    expect(screen.getByTestId("org-general-name-input")).toHaveValue("Acme");
    expect(screen.getByTestId("org-general-name-input")).toBeDisabled();
    expect(screen.queryByTestId("org-general-save-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-general-name-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("org-general-locked-note")).toBeInTheDocument();
  });

  it("keeps the save button disabled while the name is unchanged", () => {
    renderView("OWNER");

    expect(screen.getByTestId("org-general-save-button")).toBeDisabled();

    fireEvent.change(screen.getByTestId("org-general-name-input"), { target: { value: "Acme Inc" } });

    expect(screen.getByTestId("org-general-save-button")).toBeEnabled();
  });

  it("renames the organization on submit, refreshes the profile and toasts success", async () => {
    renderView("OWNER");

    fireEvent.change(screen.getByTestId("org-general-name-input"), { target: { value: "Acme Inc" } });
    fireEvent.submit(screen.getByTestId("org-general-name-form"));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({ name: "Acme Inc" });

    await getMutationOptions().onSuccess?.({ name: "Acme Inc" });

    await waitFor(() => expect(mocks.invalidateCurrent).toHaveBeenCalledTimes(1));
    expect(mocks.showToast).toHaveBeenCalledWith("Organization name updated", "success");
    expect(screen.getByTestId("org-general-name-input")).toHaveValue("Acme Inc");
  });

  it("toasts the translated server message when renaming fails", () => {
    renderView("OWNER");

    fireEvent.change(screen.getByTestId("org-general-name-input"), { target: { value: "  " } });
    fireEvent.submit(screen.getByTestId("org-general-name-form"));

    expect(mocks.mutate).toHaveBeenCalledWith({ name: "  " });

    getMutationOptions().onError?.({ message: "organization_name_invalid" });

    expect(mocks.showToast).toHaveBeenCalledWith(
      "Organization name must be between 1 and 100 characters",
      "error"
    );
    expect(mocks.invalidateCurrent).not.toHaveBeenCalled();
  });
});
