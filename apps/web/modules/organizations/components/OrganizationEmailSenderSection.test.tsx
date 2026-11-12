import type { OrganizationEmailSenderSettingsDto } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationEmailSenderSection } from "./OrganizationEmailSenderSection";

type MutationOptions = {
  onSuccess?: () => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<() => { data: OrganizationEmailSenderSettingsDto | undefined }>(),
  useMutation: vi.fn<(options: MutationOptions) => { mutate: unknown; isPending: boolean }>(),
  mutate: vi.fn<(input: { senderName?: string | null; senderAddress?: string | null }) => void>(),
  invalidate: vi.fn<() => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, options?: { domain?: string }) => (options?.domain ? `${key}:${options.domain}` : key),
  }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: { organization: { emailSender: { invalidate: mocks.invalidate } } },
    }),
    viewer: {
      organization: {
        emailSender: { useQuery: mocks.useQuery },
        updateEmailSender: { useMutation: mocks.useMutation },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

function renderSection(settings: Partial<OrganizationEmailSenderSettingsDto> = {}) {
  mocks.useQuery.mockReturnValue({
    data: {
      senderName: "Acme Team",
      senderAddress: "hello@acme.example.com",
      senderAddressActive: true,
      allowedDomain: "acme.example.com",
      fallbackSenderName: "Cal.diy",
      fallbackSenderAddress: "noreply@cal.example.com",
      canEdit: true,
      ...settings,
    },
  });
  mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.invalidate.mockResolvedValue(undefined);
  return render(<OrganizationEmailSenderSection />);
}

describe("OrganizationEmailSenderSection", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("renders nothing while loading or on error", () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    mocks.useMutation.mockReturnValue({ mutate: mocks.mutate, isPending: false });
    const { container } = render(<OrganizationEmailSenderSection />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows saved values, placeholders and the domain hint", () => {
    renderSection({ senderName: null, senderAddress: null });

    expect(screen.getByTestId("org-email-sender-name-input")).toHaveValue("");
    expect(screen.getByTestId("org-email-sender-name-input")).toHaveAttribute("placeholder", "Cal.diy");
    expect(screen.getByTestId("org-email-sender-address-input")).toHaveAttribute(
      "placeholder",
      "noreply@cal.example.com"
    );
    expect(screen.getByText("organization_email_sender_domain_hint:acme.example.com")).toBeInTheDocument();
    expect(screen.queryByTestId("org-email-sender-inactive")).not.toBeInTheDocument();
  });

  it("shows the no-domain hint and an empty address placeholder without fallbacks", () => {
    renderSection({ allowedDomain: null, fallbackSenderAddress: null });

    expect(screen.getByText("organization_email_sender_no_domain_hint")).toBeInTheDocument();
    expect(screen.getByTestId("org-email-sender-address-input")).toHaveAttribute("placeholder", "");
  });

  it("warns when a saved address is not active", () => {
    renderSection({ senderAddressActive: false });

    expect(screen.getByTestId("org-email-sender-inactive")).toBeInTheDocument();
  });

  it("is read-only when the viewer cannot edit", () => {
    renderSection({ canEdit: false });

    expect(screen.getByTestId("org-email-sender-name-input")).toBeDisabled();
    expect(screen.getByTestId("org-email-sender-address-input")).toBeDisabled();
    expect(screen.queryByTestId("org-email-sender-save")).not.toBeInTheDocument();
  });

  it("saves trimmed values", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-email-sender-name-input"), { target: { value: "  New Name " } });
    fireEvent.change(screen.getByTestId("org-email-sender-address-input"), {
      target: { value: " team@acme.example.com " },
    });
    fireEvent.click(screen.getByTestId("org-email-sender-save"));

    expect(mocks.mutate).toHaveBeenCalledWith({
      senderName: "New Name",
      senderAddress: "team@acme.example.com",
    });
  });

  it("sends null for cleared fields", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-email-sender-name-input"), { target: { value: "   " } });
    fireEvent.change(screen.getByTestId("org-email-sender-address-input"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("org-email-sender-save"));

    expect(mocks.mutate).toHaveBeenCalledWith({ senderName: null, senderAddress: null });
  });

  it("toasts and refetches on success, and toasts the translated error on failure", async () => {
    renderSection();
    const options = mocks.useMutation.mock.calls[0][0];

    await options.onSuccess?.();
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    expect(mocks.showToast).toHaveBeenCalledWith("organization_email_sender_updated", "success");

    options.onError?.({ message: "organization_email_sender_address_invalid" });
    expect(mocks.showToast).toHaveBeenCalledWith("organization_email_sender_address_invalid", "error");
  });
});
