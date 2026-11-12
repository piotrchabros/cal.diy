import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChangeEvent, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMemberActions } from "./org-member-actions";

type MutationOptions = { onSuccess: () => Promise<void>; onError: (error: { message: string }) => void };

const mocks = vi.hoisted(() => ({
  updateRoleMutate: vi.fn(),
  removeMemberMutate: vi.fn(),
  invalidate: vi.fn(),
  showToast: vi.fn(),
  options: {} as Record<"updateRole" | "removeMember", MutationOptions>,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, values?: { name: string }) => (values ? `${key}:${values.name}` : key),
  }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({ viewer: { organization: { listMembers: { invalidate: mocks.invalidate } } } }),
    viewer: {
      organization: {
        updateRole: {
          useMutation: (options: MutationOptions) => {
            mocks.options.updateRole = options;
            return { mutate: mocks.updateRoleMutate, isPending: false };
          },
        },
        removeMember: {
          useMutation: (options: MutationOptions) => {
            mocks.options.removeMember = options;
            return { mutate: mocks.removeMemberMutate, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));
vi.mock("./org-member-edit-dialog", () => ({
  OrgMemberEditDialog: ({ member, open }: { member: { userId: number }; open: boolean }) =>
    open ? <div role="dialog" aria-label={`edit-member:${member.userId}`} /> : null,
}));
vi.mock("@calcom/ui/components/button", () => ({
  Button: ({ children, type, disabled }: { children?: ReactNode; type?: "submit"; disabled?: boolean }) => (
    <button type={type ?? "button"} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@calcom/ui/components/form", () => ({
  TextField: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <label>
      {label}
      <input value={value} onChange={onChange} />
    </label>
  ),
}));
vi.mock("@calcom/ui/components/dropdown", () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dropdown: Wrap,
    DropdownMenuTrigger: Wrap,
    DropdownMenuContent: Wrap,
    DropdownMenuItem: Wrap,
    DropdownMenuLabel: Wrap,
    DropdownMenuSeparator: () => <hr />,
    DropdownItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("@calcom/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: ReactNode;
  }) => (
    <div role="dialog" aria-label={title}>
      <p>{description}</p>
      {children}
    </div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  ConfirmationDialogContent: ({ children, onConfirm }: { children: ReactNode; onConfirm: () => void }) => (
    <div role="dialog">
      {children}
      <button type="button" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
}));

type Member = Pick<
  OrganizationMemberDto,
  "userId" | "name" | "email" | "username" | "bio" | "avatarUrl" | "role" | "accepted"
>;

const MEMBER: Member = {
  userId: 11,
  name: "Ada",
  email: "ada@acme.example.com",
  username: "ada",
  bio: null,
  avatarUrl: null,
  role: "MEMBER",
  accepted: true,
};

function renderActions(viewerRole: OrganizationRoleDto, member: Member = MEMBER): ReturnType<typeof render> {
  return render(<OrgMemberActions member={member} viewerRole={viewerRole} viewerUserId={1} />);
}

describe("OrgMemberActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<[string, OrganizationRoleDto, Member]>([
    ["own row", "OWNER", { ...MEMBER, userId: 1 }],
    ["MEMBER viewer", "MEMBER", MEMBER],
    ["ADMIN viewer on an OWNER row", "ADMIN", { ...MEMBER, role: "OWNER" }],
  ])("renders nothing for the %s", (_label, viewerRole, member) => {
    const { container } = renderActions(viewerRole, member);
    expect(container).toBeEmptyDOMElement();
  });

  describe("edit", () => {
    it.each<[string, OrganizationRoleDto, Member]>([
      ["an OWNER viewer on an ADMIN row", "OWNER", { ...MEMBER, role: "ADMIN" }],
      ["an ADMIN viewer on a MEMBER row", "ADMIN", MEMBER],
      ["an OWNER viewer on a pending row", "OWNER", { ...MEMBER, accepted: false }],
    ])("is offered to %s", (_label, viewerRole, member) => {
      renderActions(viewerRole, member);
      expect(screen.getByRole("button", { name: "edit" })).toBeInTheDocument();
    });

    it.each<[string, OrganizationRoleDto, Member]>([
      ["an ADMIN viewer on an OWNER row", "ADMIN", { ...MEMBER, role: "OWNER" }],
      ["the viewer's own row", "OWNER", { ...MEMBER, userId: 1 }],
      ["an ADMIN viewer on a pending OWNER row", "ADMIN", { ...MEMBER, role: "OWNER", accepted: false }],
    ])("is hidden from %s", (_label, viewerRole, member) => {
      renderActions(viewerRole, member);
      expect(screen.queryByRole("button", { name: "edit" })).not.toBeInTheDocument();
    });

    it("opens the edit dialog for the member", () => {
      renderActions("OWNER");
      expect(screen.queryByRole("dialog", { name: "edit-member:11" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "edit" }));
      expect(screen.getByRole("dialog", { name: "edit-member:11" })).toBeInTheDocument();
    });
  });

  it("offers every other role, including owner, to an OWNER viewer", () => {
    renderActions("OWNER");
    expect(screen.getByRole("button", { name: "owner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "admin" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "member" })).not.toBeInTheDocument();
  });

  it("never offers owner to an ADMIN viewer", () => {
    renderActions("ADMIN", { ...MEMBER, role: "ADMIN" });
    expect(screen.getByRole("button", { name: "member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "owner" })).not.toBeInTheDocument();
  });

  it("updates the role, then toasts and refreshes the member list", async () => {
    renderActions("OWNER");
    fireEvent.click(screen.getByRole("button", { name: "admin" }));
    expect(mocks.updateRoleMutate).toHaveBeenCalledWith({ userId: 11, role: "ADMIN" });

    await act(() => mocks.options.updateRole.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("organization_role_updated", "success");
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("removes the member after confirmation, then toasts and refreshes the member list", async () => {
    renderActions("ADMIN");
    fireEvent.click(screen.getByRole("button", { name: "remove_organization_member" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("remove_organization_member_confirmation:Ada");

    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    expect(mocks.removeMemberMutate).toHaveBeenCalledWith({ userId: 11 });

    await act(() => mocks.options.removeMember.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("organization_member_removed", "success");
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("falls back to the email in the confirmation when the member has no name", () => {
    renderActions("OWNER", { ...MEMBER, name: null });
    fireEvent.click(screen.getByRole("button", { name: "remove_organization_member" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "remove_organization_member_confirmation:ada@acme.example.com"
    );
  });

  it("shows the translated server error", () => {
    renderActions("OWNER");
    act(() => mocks.options.updateRole.onError({ message: "user_is_already_a_member" }));
    expect(mocks.showToast).toHaveBeenCalledWith("user_is_already_a_member", "error");
  });

  describe("when the username is taken in the default organization", () => {
    function openUsernameDialog(): void {
      renderActions("OWNER");
      fireEvent.click(screen.getByRole("button", { name: "remove_organization_member" }));
      fireEvent.click(screen.getByRole("button", { name: "confirm" }));
      act(() => mocks.options.removeMember.onError({ message: "username_taken_in_default_organization" }));
    }

    it("opens the username dialog instead of toasting", () => {
      openUsernameDialog();
      expect(mocks.showToast).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "remove_organization_member" })).toHaveTextContent(
        "remove_member_username_taken_description:Ada"
      );
      expect(screen.queryByRole("button", { name: "confirm" })).not.toBeInTheDocument();
    });

    it("disables submit while the new username is empty", () => {
      openUsernameDialog();
      expect(screen.getByRole("button", { name: "remove" })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("new_username"), { target: { value: "   " } });
      expect(screen.getByRole("button", { name: "remove" })).toBeDisabled();
    });

    it("retries the removal with the trimmed new username", () => {
      openUsernameDialog();
      mocks.removeMemberMutate.mockClear();
      fireEvent.change(screen.getByLabelText("new_username"), { target: { value: "jane-new " } });
      fireEvent.click(screen.getByRole("button", { name: "remove" }));
      expect(mocks.removeMemberMutate).toHaveBeenCalledWith({ userId: 11, newUsername: "jane-new" });
    });

    it("toasts a retry error and keeps the dialog open", () => {
      openUsernameDialog();
      act(() => mocks.options.removeMember.onError({ message: "invalid_username" }));
      expect(mocks.showToast).toHaveBeenCalledWith("invalid_username", "error");
      expect(screen.getByRole("dialog", { name: "remove_organization_member" })).toBeInTheDocument();
    });

    it("closes the dialog on success", async () => {
      openUsernameDialog();
      await act(() => mocks.options.removeMember.onSuccess());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.showToast).toHaveBeenCalledWith("organization_member_removed", "success");
    });
  });

  it("toasts other removal errors", () => {
    renderActions("OWNER");
    act(() => mocks.options.removeMember.onError({ message: "forbidden" }));
    expect(mocks.showToast).toHaveBeenCalledWith("forbidden", "error");
  });
});
