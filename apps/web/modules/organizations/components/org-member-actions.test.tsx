import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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
vi.mock("@calcom/ui/components/button", () => ({ Button: () => <button type="button" /> }));
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
  ConfirmationDialogContent: ({ children, onConfirm }: { children: ReactNode; onConfirm: () => void }) => (
    <div role="dialog">
      {children}
      <button type="button" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
}));

type Member = Pick<OrganizationMemberDto, "userId" | "name" | "email" | "role" | "accepted">;

const MEMBER: Member = {
  userId: 11,
  name: "Ada",
  email: "ada@acme.example.com",
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
});
