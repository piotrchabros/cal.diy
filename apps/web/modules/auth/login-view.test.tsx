import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { signIn } from "next-auth/react";
import type { ComponentProps, InputHTMLAttributes } from "react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Login from "./login-view";

const ORG_BASE_URL = "https://acme.example.com";

const searchParamsRef: { current: URLSearchParams } = { current: new URLSearchParams() };
const push = vi.fn();
const assign = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("@calcom/lib/hooks/useCompatSearchParams", () => ({
  useCompatSearchParams: () => searchParamsRef.current,
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@calcom/web/modules/auth/hooks/useLastUsed", () => ({
  useLastUsed: () => [null, vi.fn()],
  LastUsed: () => null,
}));

// The coss Input relies on React 19 ref-as-prop; the test runtime is React 18, so react-hook-form
// would never see the DOM input without a forwardRef stand-in.
vi.mock("@coss/ui/components/input", () => ({
  Input: forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
    return <input ref={ref} {...props} />;
  }),
}));

vi.mock("@coss/ui/components/input-group", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@coss/ui/components/input-group")>()),
  InputGroupInput: forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    function InputGroupInput(props, ref) {
      return <input ref={ref} {...props} />;
    }
  ),
}));

vi.mock("@components/AddToHomescreen", () => ({ default: () => null }));
vi.mock("@components/auth/BackupCode", () => ({ default: () => null }));
vi.mock("@components/auth/TwoFactor", () => ({ default: () => null }));

const defaultProps = {
  csrfToken: "csrf",
  isGoogleLoginEnabled: false,
  isOutlookLoginEnabled: false,
  totpEmail: null,
} as unknown as ComponentProps<typeof Login>;

function renderLogin() {
  return render(
    <OrgBaseUrlContext.Provider value={{ baseUrl: ORG_BASE_URL, orgSlug: "acme" }}>
      <Login {...defaultProps} />
    </OrgBaseUrlContext.Provider>
  );
}

async function submitCredentials(container: HTMLElement) {
  const user = userEvent.setup();
  await user.type(
    container.querySelector<HTMLInputElement>("#email") as HTMLInputElement,
    "user@example.com"
  );
  await user.type(container.querySelector<HTMLInputElement>("#password") as HTMLInputElement, "secret");
  await user.click(screen.getByRole("button", { name: "continue" }));
}

describe("Login view organization sign-in", () => {
  beforeEach(() => {
    searchParamsRef.current = new URLSearchParams();
    push.mockReset();
    assign.mockReset();
    vi.mocked(signIn).mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
  });

  it("builds the callback URL on the organization's base URL", async () => {
    searchParamsRef.current = new URLSearchParams({ callbackUrl: "bookings" });
    vi.mocked(signIn).mockResolvedValue({ error: null, ok: true, status: 200, url: null });
    const { container } = renderLogin();

    await submitCredentials(container);

    await waitFor(() => expect(push).toHaveBeenCalledWith(`${ORG_BASE_URL}/bookings`));
    expect(vi.mocked(signIn).mock.calls[0][1]).toMatchObject({ callbackUrl: `${ORG_BASE_URL}/bookings` });
  });

  it("falls back to the organization's root for a foreign callback URL", async () => {
    searchParamsRef.current = new URLSearchParams({ callbackUrl: "https://evil.example.org/x" });
    vi.mocked(signIn).mockResolvedValue({ error: null, ok: true, status: 200, url: null });
    const { container } = renderLogin();

    await submitCredentials(container);

    await waitFor(() => expect(push).toHaveBeenCalledWith(`${ORG_BASE_URL}/`));
  });

  it("follows the redirect to the user's organization login page", async () => {
    const orgLoginUrl = "https://other.example.com/auth/login?reason=wrong_organization_domain";
    vi.mocked(signIn).mockResolvedValue({ error: null, ok: true, status: 200, url: orgLoginUrl });
    const { container } = renderLogin();

    await submitCredentials(container);

    await waitFor(() => expect(assign).toHaveBeenCalledWith(orgLoginUrl));
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the wrong organization domain error", async () => {
    vi.mocked(signIn).mockResolvedValue({
      error: "wrong_organization_domain",
      ok: false,
      status: 401,
      url: null,
    });
    const { container } = renderLogin();

    await submitCredentials(container);

    expect(await screen.findByText("wrong_organization_domain_error")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the notice when sent here from another organization's domain", () => {
    searchParamsRef.current = new URLSearchParams({ reason: "wrong_organization_domain" });
    renderLogin();

    expect(screen.getByText("sign_in_on_your_organization_domain")).toBeInTheDocument();
  });

  it("does not show the notice without the reason param", () => {
    renderLogin();

    expect(screen.queryByText("sign_in_on_your_organization_domain")).not.toBeInTheDocument();
  });
});
