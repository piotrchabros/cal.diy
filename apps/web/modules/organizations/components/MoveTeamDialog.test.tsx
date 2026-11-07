import type { MoveTeamPreviewDto } from "@calcom/lib/dto/OrganizationMoveDto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveTeamDialog } from "./MoveTeamDialog";

type MutationOptions = { onSuccess: () => Promise<void>; onError: (error: { message: string }) => void };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  previewUseQuery: vi.fn(),
  invalidateListTeams: vi.fn(),
  invalidateGet: vi.fn(),
  invalidateList: vi.fn(),
  onOpenChange: vi.fn(),
  showToast: vi.fn(),
  options: undefined as MutationOptions | undefined,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: {
        admin: {
          organizations: {
            listTeams: { invalidate: mocks.invalidateListTeams },
            get: { invalidate: mocks.invalidateGet },
            list: { invalidate: mocks.invalidateList },
          },
        },
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
          previewMoveTeam: { useQuery: mocks.previewUseQuery },
          moveTeam: {
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

const EMPTY_PREVIEW: MoveTeamPreviewDto = { membersOutsideTarget: [], slugTaken: false };

function renderAndSelectAcme(preview: MoveTeamPreviewDto = EMPTY_PREVIEW) {
  mocks.previewUseQuery.mockReturnValue({ data: preview });
  render(
    <MoveTeamDialog
      team={{ teamId: 5, name: "Sales", slug: "sales" }}
      organizationId={1}
      open
      onOpenChange={mocks.onOpenChange}
    />
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Acme (acme.example.com)" }));
}

describe("MoveTeamDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes the current organization and previews only once a target is picked", () => {
    mocks.previewUseQuery.mockReturnValue({ data: undefined });
    render(
      <MoveTeamDialog
        team={{ teamId: 5, name: "Sales", slug: "sales" }}
        organizationId={1}
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(mocks.previewUseQuery).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
    expect(screen.getByRole("button", { name: "move" })).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "Default (cal.example.com)" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Acme (acme.example.com)" }));

    expect(mocks.previewUseQuery).toHaveBeenLastCalledWith(
      { teamId: 5, toOrganizationId: 2 },
      { enabled: true }
    );
  });

  it("moves the team without member or slug choices when nothing conflicts", async () => {
    renderAndSelectAcme();
    expect(screen.queryByTestId("move-team-outside-members")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("new_team_slug")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ teamId: 5, toOrganizationId: 2, outsideMembers: "move" })
    );
  });

  it("lists outside members, flags taken usernames and submits the remove choice", async () => {
    renderAndSelectAcme({
      membersOutsideTarget: [
        { userId: 8, name: "Bob", email: "bob@example.com", usernameTaken: true, usernameMissing: false },
        { userId: 9, name: null, email: "eve@example.com", usernameTaken: false, usernameMissing: false },
      ],
      slugTaken: false,
    });
    expect(screen.getByText("Bob (bob@example.com)")).toBeInTheDocument();
    expect(screen.getByText("eve@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("username_taken_badge")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("move_team_outside_members_remove"));
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ teamId: 5, toOrganizationId: 2, outsideMembers: "remove" })
    );
  });

  it("asks for a new username only for taken members while moving them", () => {
    renderAndSelectAcme({
      membersOutsideTarget: [
        { userId: 8, name: "Bob", email: "bob@example.com", usernameTaken: true, usernameMissing: false },
        { userId: 9, name: null, email: "eve@example.com", usernameTaken: false, usernameMissing: false },
      ],
      slugTaken: false,
    });
    expect(screen.getAllByLabelText("move_team_member_new_username")).toHaveLength(1);
    expect(screen.getByText("move_team_member_usernames_taken_description")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("move_team_outside_members_remove"));
    expect(screen.queryByLabelText("move_team_member_new_username")).not.toBeInTheDocument();
    expect(screen.queryByText("move_team_member_usernames_taken_description")).not.toBeInTheDocument();
  });

  it("submits the trimmed new usernames when moving members with taken usernames", async () => {
    renderAndSelectAcme({
      membersOutsideTarget: [
        { userId: 8, name: "Bob", email: "bob@example.com", usernameTaken: true, usernameMissing: false },
        { userId: 9, name: null, email: "eve@example.com", usernameTaken: false, usernameMissing: false },
      ],
      slugTaken: false,
    });
    fireEvent.change(screen.getByLabelText("move_team_member_new_username"), {
      target: { value: "  bob-acme  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        teamId: 5,
        toOrganizationId: 2,
        outsideMembers: "move",
        newUsernames: [{ userId: 8, username: "bob-acme" }],
      })
    );
  });

  const MISSING_AND_TAKEN_PREVIEW: MoveTeamPreviewDto = {
    membersOutsideTarget: [
      { userId: 8, name: "Bob", email: "bob@example.com", usernameTaken: true, usernameMissing: false },
      { userId: 9, name: null, email: "eve@example.com", usernameTaken: false, usernameMissing: true },
    ],
    slugTaken: false,
  };

  it("flags members without a username and asks for one only while moving them", () => {
    renderAndSelectAcme({
      membersOutsideTarget: [
        { userId: 9, name: null, email: "eve@example.com", usernameTaken: false, usernameMissing: true },
      ],
      slugTaken: false,
    });
    expect(screen.getByText("username_missing_badge")).toBeInTheDocument();
    expect(screen.getAllByLabelText("move_team_member_new_username")).toHaveLength(1);
    expect(screen.getByText("move_team_member_usernames_missing_description")).toBeInTheDocument();
    expect(screen.queryByText("move_team_member_usernames_taken_description")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("move_team_outside_members_remove"));
    expect(screen.queryByLabelText("move_team_member_new_username")).not.toBeInTheDocument();
    expect(screen.queryByText("move_team_member_usernames_missing_description")).not.toBeInTheDocument();
  });

  it("submits trimmed new usernames for both missing and taken members", async () => {
    renderAndSelectAcme(MISSING_AND_TAKEN_PREVIEW);
    expect(screen.getByText("move_team_member_usernames_taken_description")).toBeInTheDocument();
    expect(screen.getByText("move_team_member_usernames_missing_description")).toBeInTheDocument();

    const [bobField, eveField] = screen.getAllByLabelText("move_team_member_new_username");
    fireEvent.change(bobField, { target: { value: "  bob-acme  " } });
    fireEvent.change(eveField, { target: { value: " eve " } });
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        teamId: 5,
        toOrganizationId: 2,
        outsideMembers: "move",
        newUsernames: [
          { userId: 8, username: "bob-acme" },
          { userId: 9, username: "eve" },
        ],
      })
    );
  });

  it("asks for a new slug when it is taken and submits it", async () => {
    renderAndSelectAcme({ membersOutsideTarget: [], slugTaken: true });
    const slugField = screen.getByLabelText("new_team_slug");
    expect(slugField).toHaveValue("sales");

    fireEvent.change(slugField, { target: { value: "sales-acme" } });
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        teamId: 5,
        toOrganizationId: 2,
        outsideMembers: "move",
        newSlug: "sales-acme",
      })
    );
  });

  it("toasts the translated server message on error", () => {
    renderAndSelectAcme();
    act(() => mocks.options?.onError({ message: "member_usernames_taken_in_target_organization" }));
    expect(mocks.showToast).toHaveBeenCalledWith("member_usernames_taken_in_target_organization", "error");
    expect(mocks.onOpenChange).not.toHaveBeenCalled();
  });

  it("toasts, invalidates the organization queries and closes on success", async () => {
    renderAndSelectAcme();
    await act(() => mocks.options?.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("team_moved_to_organization", "success");
    expect(mocks.invalidateListTeams).toHaveBeenCalled();
    expect(mocks.invalidateGet).toHaveBeenCalled();
    expect(mocks.invalidateList).toHaveBeenCalled();
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });
});
