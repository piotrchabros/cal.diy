import type { OrganizationMemberDto } from "@calcom/lib/dto/OrganizationDto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMemberEditDialog } from "./org-member-edit-dialog";

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
        updateMemberProfile: {
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

vi.mock("@calcom/ui/components/avatar", () => ({
  UserAvatar: ({ previewSrc }: { previewSrc?: string }) => (
    <div data-testid="member-avatar" data-src={previewSrc ?? ""} />
  ),
}));

vi.mock("@calcom/ui/components/image-uploader", () => ({
  ImageUploader: ({ handleAvatarChange }: { handleAvatarChange: (src: string) => void }) => (
    <button type="button" onClick={() => handleAvatarChange("data:image/png;base64,NEW")}>
      upload_avatar
    </button>
  ),
}));

vi.mock("@calcom/ui/components/editor", () => ({
  Editor: ({ getText, setText }: { getText: () => string; setText: (value: string) => void }) => (
    <textarea
      aria-label="bio-editor"
      defaultValue={getText()}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
    />
  ),
}));

type Member = Pick<OrganizationMemberDto, "userId" | "name" | "email" | "username" | "bio" | "avatarUrl">;

const MEMBER: Member = {
  userId: 11,
  name: "Ada",
  email: "ada@acme.example.com",
  username: "ada",
  bio: null,
  avatarUrl: "/api/avatar/ada.png",
};

const onOpenChange = vi.fn();

function renderDialog(member: Member = MEMBER) {
  return render(<OrgMemberEditDialog member={member} open onOpenChange={onOpenChange} />);
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "save" }));

describe("OrgMemberEditDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefills the member's details with a read-only email", () => {
    renderDialog();
    expect(screen.getByLabelText("full_name")).toHaveValue("Ada");
    expect(screen.getByLabelText("username")).toHaveValue("ada");
    expect(screen.getByLabelText("email")).toHaveValue("ada@acme.example.com");
    expect(screen.getByLabelText("email")).toHaveAttribute("readonly");
    expect(screen.getByTestId("member-avatar").getAttribute("data-src")).toContain("/api/avatar/ada.png");
  });

  it("sends only the changed fields", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("full_name"), { target: { value: "Ada Lovelace" } });
    save();

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ userId: 11, name: "Ada Lovelace" }));
  });

  it("sends the bio when it changes", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("bio-editor"), { target: { value: "Hello" } });
    save();

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ userId: 11, bio: "Hello" }));
  });

  it("sends a null avatar when the picture is removed", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    save();

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ userId: 11, avatar: null }));
  });

  it("sends the uploaded picture as a data URL", async () => {
    renderDialog({ ...MEMBER, avatarUrl: null });
    expect(screen.queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "upload_avatar" }));
    save();

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({ userId: 11, avatar: "data:image/png;base64,NEW" })
    );
  });

  it("slugifies the username and warns only once it changes", async () => {
    renderDialog();
    expect(screen.queryByText("org_member_username_change_warning")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("username"), { target: { value: "Ada Love" } });
    expect(screen.getByLabelText("username")).toHaveValue("ada-love");
    expect(screen.getByText("org_member_username_change_warning")).toBeInTheDocument();

    save();
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ userId: 11, username: "ada-love" }));
  });

  it("drops the warning when the username is changed back", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "adal" } });
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "ada" } });
    expect(screen.queryByText("org_member_username_change_warning")).not.toBeInTheDocument();
  });

  it("blocks submitting an empty name", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("full_name"), { target: { value: "   " } });
    save();

    expect(await screen.findByText("you_need_to_add_a_name")).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("blocks submitting a name over the limit", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("full_name"), { target: { value: "a".repeat(51) } });
    save();

    expect(await screen.findByText("max_limit_allowed_hint")).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("closes without a request when nothing changed", async () => {
    renderDialog();
    save();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("toasts, refreshes the member list and closes on success", async () => {
    renderDialog();
    await act(() => mocks.options?.onSuccess());
    expect(mocks.showToast).toHaveBeenCalledWith("organization_member_profile_updated", "success");
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the translated server error and stays open", () => {
    renderDialog();
    act(() => mocks.options?.onError({ message: "username_already_taken" }));
    expect(mocks.showToast).toHaveBeenCalledWith("username_already_taken", "error");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
