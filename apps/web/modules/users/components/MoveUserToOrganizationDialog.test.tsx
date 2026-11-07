import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveUserToOrganizationDialog } from "./MoveUserToOrganizationDialog";

type MoveError = { message: string; data?: { code: string } };
type MutationOptions = { onSuccess: () => Promise<void>; onError: (error: MoveError) => void };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateGet: vi.fn(),
  invalidateList: vi.fn(),
  refresh: vi.fn(),
  showToast: vi.fn(),
  options: undefined as MutationOptions | undefined,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: {
        users: { get: { invalidate: mocks.invalidateGet }, list: { invalidate: mocks.invalidateList } },
      },
    }),
    viewer: {
      admin: {
        organizations: {
          list: {
            useQuery: () => ({
              data: {
                items: [
                  { id: 1, name: "Default", domain: "cal.example.com" },
                  { id: 2, name: "Acme", domain: "acme.example.com" },
                ],
              },
              isFetching: false,
            }),
          },
          moveUser: {
            useMutation: (options: MutationOptions) => {
              mocks.options = options;
              return { mutate: mocks.mutate, isPending: false };
            },
          },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

function openDialogAndSelectAcme() {
  render(<MoveUserToOrganizationDialog userId={7} currentOrganizationId={1} currentUsername="jane" />);
  fireEvent.click(screen.getByRole("button", { name: "move_to_organization" }));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Acme (acme.example.com)" }));
}

describe("MoveUserToOrganizationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes the user's current organization from the options", () => {
    render(<MoveUserToOrganizationDialog userId={7} currentOrganizationId={1} currentUsername="jane" />);
    fireEvent.click(screen.getByRole("button", { name: "move_to_organization" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Acme (acme.example.com)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Default (cal.example.com)" })).not.toBeInTheDocument();
  });

  it("moves the user to the selected organization", async () => {
    openDialogAndSelectAcme();
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ userId: 7, toOrganizationId: 2 }));
  });

  it("asks for a new username when it is taken and resubmits with it", async () => {
    openDialogAndSelectAcme();
    act(() =>
      mocks.options?.onError({
        message: "username_taken_in_target_organization",
        data: { code: "CONFLICT" },
      })
    );

    const usernameField = screen.getByLabelText("new_username");
    expect(usernameField).toHaveValue("jane");
    expect(screen.getByText("move_user_username_taken_description")).toBeInTheDocument();
    expect(mocks.showToast).not.toHaveBeenCalled();

    fireEvent.change(usernameField, { target: { value: "jane-acme" } });
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ userId: 7, toOrganizationId: 2, newUsername: "jane-acme" })
    );
  });

  it("toasts the translated message for other errors", () => {
    openDialogAndSelectAcme();
    act(() =>
      mocks.options?.onError({ message: "last_owner_cannot_move", data: { code: "PRECONDITION_FAILED" } })
    );
    expect(mocks.showToast).toHaveBeenCalledWith("last_owner_cannot_move", "error");
    expect(screen.queryByLabelText("new_username")).not.toBeInTheDocument();
  });

  it("toasts, invalidates the user queries and refreshes on success", async () => {
    openDialogAndSelectAcme();
    await act(() => mocks.options?.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("user_moved_to_organization", "success");
    expect(mocks.invalidateGet).toHaveBeenCalled();
    expect(mocks.invalidateList).toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
