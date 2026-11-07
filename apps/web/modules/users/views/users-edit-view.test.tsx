import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersEditView } from "./users-edit-view";

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/admin/users/7/edit",
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({}),
    viewer: { users: { update: { useMutation: () => ({ mutate: vi.fn() }) } } },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: vi.fn() }));

vi.mock("../components/UserForm", () => ({ UserForm: () => <form data-testid="user-form" /> }));

vi.mock("../components/MoveUserToOrganizationDialog", () => ({
  MoveUserToOrganizationDialog: ({ currentOrganizationId }: { currentOrganizationId: number | null }) => (
    <div data-testid="move-user-dialog">{currentOrganizationId}</div>
  ),
}));

const user = {
  id: 7,
  name: "Jane",
  email: "jane@example.com",
  username: "jane",
  bio: null,
  timeZone: "UTC",
  weekStart: "Monday",
  theme: null,
  defaultScheduleId: null,
  locale: null,
  timeFormat: null,
  allowDynamicBooking: null,
  identityProvider: null,
  role: null,
  avatarUrl: null,
  organizationId: 3,
};

describe("UsersEditView", () => {
  it("renders the move section with the user's organization when organizations are enabled", () => {
    render(<UsersEditView user={user} organizationsEnabled />);
    expect(screen.getByTestId("user-form")).toBeInTheDocument();
    expect(screen.getByTestId("move-user-dialog")).toHaveTextContent("3");
  });

  it("hides the move section when organizations are disabled", () => {
    render(<UsersEditView user={user} />);
    expect(screen.getByTestId("user-form")).toBeInTheDocument();
    expect(screen.queryByTestId("move-user-organization-section")).not.toBeInTheDocument();
  });
});
