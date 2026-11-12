import type { OrganizationNotetakerSettingsDto } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationNotetakerBotSection } from "./OrganizationNotetakerBotSection";

type MutationOptions = {
  onSuccess?: () => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<() => { data: OrganizationNotetakerSettingsDto | undefined }>(),
  useMutation: vi.fn<(options: MutationOptions) => { mutate: unknown; isPending: boolean }>(),
  mutate: vi.fn<(input: { botName?: string | null; botImage?: string | null }) => void>(),
  invalidate: vi.fn<() => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: { organization: { notetakerSettings: { invalidate: mocks.invalidate } } },
    }),
    viewer: {
      organization: {
        notetakerSettings: { useQuery: mocks.useQuery },
        updateNotetakerSettings: { useMutation: mocks.useMutation },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

vi.mock("@calcom/ui/components/image-uploader", () => ({
  BannerUploader: ({ handleAvatarChange }: { handleAvatarChange: (src: string) => void }) => (
    <button
      type="button"
      data-testid="mock-uploader"
      onClick={() => handleAvatarChange("data:image/jpeg;base64,NEW")}>
      upload
    </button>
  ),
}));

function renderSection(settings: Partial<OrganizationNotetakerSettingsDto> = {}) {
  mocks.useQuery.mockReturnValue({
    data: {
      botName: "Acme Bot",
      botImageDataUrl: null,
      fallbackBotName: "Acme",
      canEdit: true,
      ...settings,
    },
  });
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.invalidate.mockResolvedValue(undefined);
  return render(<OrganizationNotetakerBotSection />);
}

describe("OrganizationNotetakerBotSection", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("renders nothing while loading or on error", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
    const { container } = render(<OrganizationNotetakerBotSection />);

    expect(container).toBeEmptyDOMElement();
  });

  it("is read-only when the viewer cannot edit", () => {
    renderSection({ canEdit: false, botImageDataUrl: "data:image/jpeg;base64,AAA" });

    expect(screen.getByTestId("org-notetaker-bot-name-input")).toBeDisabled();
    expect(screen.queryByTestId("org-notetaker-bot-name-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-uploader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-notetaker-bot-image-remove")).not.toBeInTheDocument();
  });

  it("saves the entered name", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-notetaker-bot-name-input"), { target: { value: "Helper" } });
    fireEvent.click(screen.getByTestId("org-notetaker-bot-name-save"));

    expect(mocks.mutate).toHaveBeenCalledWith({ botName: "Helper" });
  });

  it("sends null when the name is emptied", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-notetaker-bot-name-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("org-notetaker-bot-name-save"));

    expect(mocks.mutate).toHaveBeenCalledWith({ botName: null });
  });

  it("removes the image by sending null", () => {
    renderSection({ botImageDataUrl: "data:image/jpeg;base64,AAA" });

    fireEvent.click(screen.getByTestId("org-notetaker-bot-image-remove"));

    expect(mocks.mutate).toHaveBeenCalledWith({ botImage: null });
  });

  it("sends the cropped image from the uploader", () => {
    renderSection();

    fireEvent.click(screen.getByTestId("mock-uploader"));

    expect(mocks.mutate).toHaveBeenCalledWith({ botImage: "data:image/jpeg;base64,NEW" });
  });

  it("previews the current image or the empty state", () => {
    const { unmount } = renderSection({ botImageDataUrl: "data:image/jpeg;base64,AAA" });
    expect(screen.getByTestId("org-notetaker-bot-image-preview")).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,AAA"
    );
    unmount();

    renderSection({ botImageDataUrl: null });
    expect(screen.getByTestId("org-notetaker-bot-image-empty")).toBeInTheDocument();
  });

  it("invalidates the query and toasts on success, translates errors", async () => {
    renderSection();
    const options = mocks.useMutation.mock.calls[0][0];

    await options.onSuccess?.();
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_bot_settings_saved", "success");

    options.onError?.({ message: "notetaker_bot_image_invalid" });
    expect(mocks.showToast).toHaveBeenCalledWith("notetaker_bot_image_invalid", "error");
  });
});
