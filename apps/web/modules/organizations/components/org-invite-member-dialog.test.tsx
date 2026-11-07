import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgInviteMemberDialog } from "./org-invite-member-dialog";

type MutationOptions = { onSuccess: () => Promise<void>; onError: (error: { message: string }) => void };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  showToast: vi.fn(),
  options: undefined as MutationOptions | undefined,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({ viewer: { organization: { listMembers: { invalidate: mocks.invalidate } } } }),
    viewer: {
      organization: {
        inviteMember: {
          useMutation: (options: MutationOptions) => {
            mocks.options = options;
            return { mutate: mocks.mutate, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

const onOpenChange = vi.fn();

function renderDialog(viewerRole: OrganizationRoleDto) {
  return render(<OrgInviteMemberDialog viewerRole={viewerRole} open onOpenChange={onOpenChange} />);
}

function openRoleMenu() {
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
}

describe("OrgInviteMemberDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers member and admin, but not owner, to an ADMIN viewer", () => {
    renderDialog("ADMIN");
    openRoleMenu();
    expect(screen.getByRole("option", { name: "admin" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "member" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "owner" })).not.toBeInTheDocument();
  });

  it("also offers owner to an OWNER viewer", () => {
    renderDialog("OWNER");
    openRoleMenu();
    expect(screen.getByRole("option", { name: "owner" })).toBeInTheDocument();
  });

  it("submits the email and chosen role", async () => {
    renderDialog("OWNER");
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "new@acme.example.com" } });
    openRoleMenu();
    fireEvent.click(screen.getByRole("option", { name: "admin" }));
    fireEvent.click(screen.getByRole("button", { name: "invite" }));

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ email: "new@acme.example.com", role: "ADMIN" })
    );
  });

  it("toasts, refreshes the member list and closes on success", async () => {
    renderDialog("ADMIN");
    await act(() => mocks.options?.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("organization_member_invited", "success");
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the translated server error", () => {
    renderDialog("ADMIN");
    act(() => mocks.options?.onError({ message: "user_belongs_to_another_organization" }));
    expect(mocks.showToast).toHaveBeenCalledWith("user_belongs_to_another_organization", "error");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
