import type { OrganizationEmailSenderSettingsDto } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import type { OrganizationSmtpSettingsDto } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationSmtpSection } from "./OrganizationSmtpSection";

type MutationOptions = {
  onSuccess?: () => Promise<void> | void;
  onError?: (error: { message: string }) => void;
};
type Mutation = { mutate: (input?: unknown) => void; isPending: boolean };

const mocks = vi.hoisted(() => ({
  useSmtpQuery: vi.fn<() => { data: OrganizationSmtpSettingsDto | undefined; isError: boolean }>(),
  useEmailSenderQuery: vi.fn<() => { data: OrganizationEmailSenderSettingsDto | undefined }>(),
  updateOptions: undefined as MutationOptions | undefined,
  removeOptions: undefined as MutationOptions | undefined,
  testOptions: undefined as MutationOptions | undefined,
  update: vi.fn<(input?: unknown) => void>(),
  remove: vi.fn<(input?: unknown) => void>(),
  test: vi.fn<(input?: unknown) => void>(),
  invalidateSmtp: vi.fn<() => Promise<void>>(),
  invalidateEmailSender: vi.fn<() => Promise<void>>(),
  showToast: vi.fn<(message: string, variant: string) => void>(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@calcom/trpc/react", () => ({
  trpc: {
    useUtils: () => ({
      viewer: {
        organization: {
          smtpSettings: { invalidate: mocks.invalidateSmtp },
          emailSender: { invalidate: mocks.invalidateEmailSender },
        },
      },
    }),
    viewer: {
      organization: {
        smtpSettings: { useQuery: mocks.useSmtpQuery },
        emailSender: { useQuery: mocks.useEmailSenderQuery },
        updateSmtpSettings: {
          useMutation: (options: MutationOptions): Mutation => {
            mocks.updateOptions = options;
            return { mutate: mocks.update, isPending: false };
          },
        },
        removeSmtpSettings: {
          useMutation: (options: MutationOptions): Mutation => {
            mocks.removeOptions = options;
            return { mutate: mocks.remove, isPending: false };
          },
        },
        testSmtpSettings: {
          useMutation: (options: MutationOptions): Mutation => {
            mocks.testOptions = options;
            return { mutate: mocks.test, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@calcom/ui/components/toast", () => ({ showToast: mocks.showToast }));

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

const CONFIGURED: OrganizationSmtpSettingsDto = {
  configured: true,
  host: "smtp.acme.example.com",
  port: 587,
  security: "STARTTLS",
  username: "mailer@acme.example.com",
  hasPassword: true,
  lastVerifiedAt: null,
  canEdit: true,
};

const UNCONFIGURED: OrganizationSmtpSettingsDto = {
  configured: false,
  host: null,
  port: null,
  security: null,
  username: null,
  hasPassword: false,
  lastVerifiedAt: null,
  canEdit: true,
};

const EMAIL_SENDER: OrganizationEmailSenderSettingsDto = {
  senderName: "Acme Team",
  senderAddress: null,
  senderAddressActive: false,
  allowedDomain: "acme.example.com",
  fallbackSenderName: "Cal.diy",
  fallbackSenderAddress: "noreply@cal.example.com",
  canEdit: true,
  usesOrganizationSmtp: true,
};

function renderSection(
  settings: Partial<OrganizationSmtpSettingsDto> = {},
  emailSender: Partial<OrganizationEmailSenderSettingsDto> = {},
  base: OrganizationSmtpSettingsDto = CONFIGURED
) {
  mocks.useSmtpQuery.mockReturnValue({ data: { ...base, ...settings }, isError: false });
  mocks.useEmailSenderQuery.mockReturnValue({ data: { ...EMAIL_SENDER, ...emailSender } });
  return render(<OrganizationSmtpSection />);
}

function chooseOption(testId: string, label: string) {
  fireEvent.keyDown(screen.getByTestId(testId).querySelector("input") as HTMLInputElement, {
    key: "ArrowDown",
  });
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("OrganizationSmtpSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invalidateSmtp.mockResolvedValue(undefined);
    mocks.invalidateEmailSender.mockResolvedValue(undefined);
  });

  it("renders nothing while loading or on error", () => {
    mocks.useEmailSenderQuery.mockReturnValue({ data: undefined });
    mocks.useSmtpQuery.mockReturnValue({ data: undefined, isError: false });
    const { container, unmount } = render(<OrganizationSmtpSection />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    mocks.useSmtpQuery.mockReturnValue({ data: CONFIGURED, isError: true });
    const { container: errored } = render(<OrganizationSmtpSection />);
    expect(errored).toBeEmptyDOMElement();
  });

  it("shows the saved settings with the password unchanged placeholder", () => {
    renderSection();

    expect(screen.getByTestId("org-smtp-host-input")).toHaveValue("smtp.acme.example.com");
    expect(screen.getByTestId("org-smtp-port-select")).toHaveTextContent("587");
    expect(screen.getByTestId("org-smtp-security-select")).toHaveTextContent(
      "organization_smtp_security_starttls"
    );
    expect(screen.getByTestId("org-smtp-username-input")).toHaveValue("mailer@acme.example.com");
    expect(screen.getByTestId("org-smtp-password-input")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("org-smtp-password-input")).toHaveAttribute(
      "placeholder",
      "organization_smtp_password_unchanged"
    );
    expect(screen.getByText("organization_smtp_optional_auth_hint")).toBeInTheDocument();
    expect(screen.queryByTestId("org-smtp-security-none-warning")).not.toBeInTheDocument();
  });

  it("defaults an unconfigured server to port 587 with STARTTLS and hides test-only actions", () => {
    renderSection({}, { usesOrganizationSmtp: false }, UNCONFIGURED);

    expect(screen.getByTestId("org-smtp-host-input")).toHaveValue("");
    expect(screen.getByTestId("org-smtp-port-select")).toHaveTextContent("587");
    expect(screen.queryByTestId("org-smtp-password-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("org-smtp-test")).toBeDisabled();
    expect(screen.queryByTestId("org-smtp-remove")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-smtp-from")).not.toBeInTheDocument();
  });

  it("shows the password field only while a username is entered", () => {
    renderSection({ username: null, hasPassword: false });

    expect(screen.queryByTestId("org-smtp-password-input")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("org-smtp-username-input"), { target: { value: "mailer" } });
    expect(screen.getByTestId("org-smtp-password-input")).toHaveAttribute("placeholder", "");
  });

  it("warns when the connection is not encrypted", () => {
    renderSection({ security: "NONE" });

    expect(screen.getByTestId("org-smtp-security-none-warning")).toBeInTheDocument();
  });

  it("saves trimmed values and omits an empty password", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-smtp-host-input"), {
      target: { value: " smtp.new.example.com " },
    });
    fireEvent.change(screen.getByTestId("org-smtp-username-input"), { target: { value: " user@acme.io " } });
    fireEvent.click(screen.getByTestId("org-smtp-save"));

    expect(mocks.update).toHaveBeenCalledWith({
      host: "smtp.new.example.com",
      port: 587,
      security: "STARTTLS",
      username: "user@acme.io",
    });
  });

  it("saves the chosen port, security and a new password", () => {
    renderSection();

    chooseOption("org-smtp-port-select", "465");
    chooseOption("org-smtp-security-select", "organization_smtp_security_ssl");
    fireEvent.change(screen.getByTestId("org-smtp-password-input"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("org-smtp-save"));

    expect(mocks.update).toHaveBeenCalledWith({
      host: "smtp.acme.example.com",
      port: 465,
      security: "SSL",
      username: "mailer@acme.example.com",
      password: "s3cret",
    });
  });

  it("sends a null username and no password for an IP-allowlisted relay", () => {
    renderSection();

    fireEvent.change(screen.getByTestId("org-smtp-password-input"), { target: { value: "stale" } });
    fireEvent.change(screen.getByTestId("org-smtp-username-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("org-smtp-save"));

    expect(mocks.update).toHaveBeenCalledWith({
      host: "smtp.acme.example.com",
      port: 587,
      security: "STARTTLS",
      username: null,
    });
  });

  it("enables the test only while the saved settings are unchanged, and sends a test email", () => {
    renderSection();

    expect(screen.getByTestId("org-smtp-test")).toBeEnabled();
    fireEvent.click(screen.getByTestId("org-smtp-test"));
    expect(mocks.test).toHaveBeenCalledWith({ sendTestEmail: true });

    fireEvent.change(screen.getByTestId("org-smtp-host-input"), {
      target: { value: "smtp.other.example.com" },
    });
    expect(screen.getByTestId("org-smtp-test")).toBeDisabled();
  });

  it("removes the settings after confirmation", () => {
    renderSection();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("org-smtp-remove"));
    expect(screen.getByRole("dialog")).toHaveTextContent("organization_smtp_remove_confirm");
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    expect(mocks.remove).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the active organization sender address as From", () => {
    renderSection({}, { senderAddress: "hello@acme.example.com", senderAddressActive: true });

    expect(screen.getByTestId("org-smtp-from")).toHaveTextContent("hello@acme.example.com");
    expect(screen.queryByTestId("org-smtp-no-sender-warning")).not.toBeInTheDocument();
  });

  it("falls back to an email-like username as From", () => {
    renderSection({}, { senderAddress: "old@other.example.com", senderAddressActive: false });

    expect(screen.getByTestId("org-smtp-from")).toHaveTextContent("mailer@acme.example.com");
  });

  it("warns when there is no address to send from", () => {
    renderSection({ username: "apikey" });

    expect(screen.getByTestId("org-smtp-no-sender-warning")).toHaveTextContent(
      "organization_smtp_no_sender_warning"
    );
  });

  it("shows when the settings were last verified", () => {
    renderSection({ lastVerifiedAt: "2026-11-01T10:00:00.000Z" });

    expect(screen.getByTestId("org-smtp-last-verified")).toHaveTextContent(
      `organization_smtp_last_verified: ${new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date("2026-11-01T10:00:00.000Z"))}`
    );
  });

  it("is read-only without a password field or actions when the viewer cannot edit", () => {
    renderSection({ canEdit: false });

    expect(screen.getByTestId("org-smtp-host-input")).toBeDisabled();
    expect(screen.getByTestId("org-smtp-username-input")).toBeDisabled();
    expect(screen.queryByTestId("org-smtp-password-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-smtp-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-smtp-test")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-smtp-remove")).not.toBeInTheDocument();
  });

  it("toasts and refetches after save and remove, and toasts translated errors", async () => {
    renderSection();

    await mocks.updateOptions?.onSuccess?.();
    expect(mocks.showToast).toHaveBeenCalledWith("organization_smtp_saved", "success");
    await mocks.removeOptions?.onSuccess?.();
    expect(mocks.showToast).toHaveBeenCalledWith("organization_smtp_removed", "success");
    await waitFor(() => expect(mocks.invalidateSmtp).toHaveBeenCalledTimes(2));
    expect(mocks.invalidateEmailSender).toHaveBeenCalledTimes(2);

    mocks.updateOptions?.onError?.({ message: "organization_smtp_host_private" });
    expect(mocks.showToast).toHaveBeenCalledWith("organization_smtp_host_private", "error");
    mocks.removeOptions?.onError?.({ message: "organization_only_managers_can_update_organization" });
    expect(mocks.showToast).toHaveBeenCalledWith(
      "organization_only_managers_can_update_organization",
      "error"
    );
  });

  it("toasts the test result and refreshes the verification time", async () => {
    renderSection();

    await mocks.testOptions?.onSuccess?.();
    expect(mocks.showToast).toHaveBeenCalledWith("organization_smtp_test_sent", "success");
    expect(mocks.invalidateSmtp).toHaveBeenCalled();

    mocks.testOptions?.onError?.({ message: "organization_smtp_test_failed_auth" });
    expect(mocks.showToast).toHaveBeenCalledWith("organization_smtp_test_failed_auth", "error");
  });
});
