import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationLogoSection } from "./OrganizationLogoSection";

type MutationOptions = {
  onSuccess?: (data: { logoUrl: string | null }) => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn<(options: MutationOptions) => { mutate: unknown; isPending: boolean }>(),
  mutate: vi.fn<(input: { logo: string | null }) => void>(),
  invalidateCurrent: vi.fn<() => Promise<void>>(),
  updateSession: vi.fn<(data: unknown) => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ update: mocks.updateSession }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: { organization: { current: { invalidate: mocks.invalidateCurrent } } },
    }),
    viewer: {
      organization: {
        updateLogo: { useMutation: mocks.useMutation },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/ui/components/avatar", () => ({
  Avatar: ({ imageSrc }: { imageSrc?: string }) => (
    <div data-testid="org-logo-avatar" data-src={imageSrc ?? ""} />
  ),
}));

vi.mock("@calcom/ui/components/image-uploader", () => ({
  ImageUploader: ({ handleAvatarChange }: { handleAvatarChange: (src: string) => void }) => (
    <button
      type="button"
      data-testid="mock-uploader"
      onClick={() => handleAvatarChange("data:image/png;base64,NEW")}>
      upload
    </button>
  ),
}));

function renderSection(props: { logoUrl?: string | null; canEdit?: boolean } = {}) {
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.invalidateCurrent.mockResolvedValue(undefined);
  mocks.updateSession.mockResolvedValue(undefined);
  return render(
    <OrganizationLogoSection
      organizationName="Acme"
      logoUrl={props.logoUrl ?? null}
      canEdit={props.canEdit ?? true}
    />
  );
}

function getMutationOptions(): MutationOptions {
  return mocks.useMutation.mock.calls[0][0];
}

describe("OrganizationLogoSection", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("shows a read-only avatar to members", () => {
    renderSection({ canEdit: false, logoUrl: "/logo.png" });

    expect(screen.getByTestId("org-logo-avatar")).toHaveAttribute("data-src", "/logo.png");
    expect(screen.queryByTestId("mock-uploader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-logo-remove-button")).not.toBeInTheDocument();
  });

  it("hides the remove button when there is no logo", () => {
    renderSection({ logoUrl: null });

    expect(screen.getByTestId("mock-uploader")).toBeInTheDocument();
    expect(screen.queryByTestId("org-logo-remove-button")).not.toBeInTheDocument();
  });

  it("uploads the cropped image as a data URL", () => {
    renderSection();

    fireEvent.click(screen.getByTestId("mock-uploader"));

    expect(mocks.mutate).toHaveBeenCalledWith({ logo: "data:image/png;base64,NEW" });
  });

  it("removes the logo", () => {
    renderSection({ logoUrl: "/logo.png" });

    fireEvent.click(screen.getByTestId("org-logo-remove-button"));

    expect(mocks.mutate).toHaveBeenCalledWith({ logo: null });
  });

  it("updates the avatar, refreshes the organization and session, and toasts on success", async () => {
    renderSection();

    await getMutationOptions().onSuccess?.({ logoUrl: "/new-logo.png" });

    await waitFor(() =>
      expect(screen.getByTestId("org-logo-avatar")).toHaveAttribute("data-src", "/new-logo.png")
    );
    expect(mocks.invalidateCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.updateSession).toHaveBeenCalledWith({ refreshOrganization: true });
    expect(mocks.showToast).toHaveBeenCalledWith("organization_logo_updated", "success");
  });

  it("toasts the translated server message on error", () => {
    renderSection();

    getMutationOptions().onError?.({ message: "organization_logo_invalid" });

    expect(mocks.showToast).toHaveBeenCalledWith("organization_logo_invalid", "error");
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});
