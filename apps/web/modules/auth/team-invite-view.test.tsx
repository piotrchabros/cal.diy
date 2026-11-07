import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { signIn } from "next-auth/react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeamInviteView from "./team-invite-view";

const ORG_BASE_URL = "https://acme.example.com";
const LANDING_PATH = "/settings/organization/members";
const CALLBACK_URL = `${ORG_BASE_URL}${LANDING_PATH}`;

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock("@components/ui/AuthContainer", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

const baseInvite = {
  teamId: 7,
  teamName: "Acme",
  email: "invitee@example.com",
  isOrganization: true,
};

type SubmitResponse = { ok: boolean; body?: Record<string, unknown> };

function mockFetch(submitResponse: SubmitResponse = { ok: true, body: {} }) {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/csrf") {
      return Promise.resolve({ json: () => Promise.resolve({ csrfToken: "csrf-1" }) });
    }
    return Promise.resolve({
      ok: submitResponse.ok,
      json: () => Promise.resolve(submitResponse.body ?? {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderView(flags: { needsPassword: boolean; needsUsername: boolean }) {
  return render(
    <OrgBaseUrlContext.Provider value={{ baseUrl: ORG_BASE_URL, orgSlug: "acme" }}>
      <TooltipProvider>
        <TeamInviteView invite={{ ...baseInvite, ...flags }} token="tok" landingPath={LANDING_PATH} />
      </TooltipProvider>
    </OrgBaseUrlContext.Provider>
  );
}

function getSubmitBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/auth/team-invite") as unknown as [
    string,
    RequestInit,
  ];
  return JSON.parse(call[1].body as string);
}

async function waitForCsrf(fetchMock: ReturnType<typeof mockFetch>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/csrf", { cache: "no-store" }));
}

describe("TeamInviteView", () => {
  beforeEach(() => {
    push.mockReset();
    vi.mocked(signIn).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks only for a username and sends the invitee to log in", async () => {
    const fetchMock = mockFetch();
    renderView({ needsPassword: false, needsUsername: true });
    await waitForCsrf(fetchMock);

    expect(screen.queryByLabelText("password")).toBeNull();
    expect(screen.queryByLabelText("confirm_password")).toBeNull();
    expect(screen.getByText("team_invite_choose_username_description")).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("username"), "jane");
    await user.click(screen.getByRole("button", { name: "team_invite_complete_submit" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(getSubmitBody(fetchMock)).toEqual({ token: "tok", csrfToken: "csrf-1", username: "jane" });
    expect(signIn).not.toHaveBeenCalled();
    const loginParams = new URLSearchParams({ email: baseInvite.email, callbackUrl: CALLBACK_URL });
    expect(push).toHaveBeenCalledWith(`/auth/login?${loginParams.toString()}`);
  });

  it("asks for a username and a password and signs the invitee in", async () => {
    const fetchMock = mockFetch();
    vi.mocked(signIn).mockResolvedValue({ error: null, ok: true, status: 200, url: null });
    renderView({ needsPassword: true, needsUsername: true });
    await waitForCsrf(fetchMock);

    expect(screen.getByText("team_invite_complete_account_description")).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("username"), "jane");
    await user.type(screen.getByLabelText("password"), "Password123");
    await user.type(screen.getByLabelText("confirm_password"), "Password123");
    await user.click(screen.getByRole("button", { name: "team_invite_complete_submit" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(CALLBACK_URL));
    expect(getSubmitBody(fetchMock)).toEqual({
      token: "tok",
      csrfToken: "csrf-1",
      password: "Password123",
      username: "jane",
    });
    expect(vi.mocked(signIn).mock.calls[0][1]).toMatchObject({
      email: baseInvite.email,
      password: "Password123",
      callbackUrl: CALLBACK_URL,
    });
  });

  it("asks only for a password when the invitee already has a username", async () => {
    const fetchMock = mockFetch();
    renderView({ needsPassword: true, needsUsername: false });
    await waitForCsrf(fetchMock);

    expect(screen.queryByLabelText("username")).toBeNull();
    expect(screen.getByLabelText("password")).toBeTruthy();
    expect(screen.getByText("team_invite_set_password_description")).toBeTruthy();
    expect(screen.getByRole("button", { name: "team_invite_set_password_submit" })).toBeTruthy();
  });

  it("shows the translated message when the username is taken in the organization", async () => {
    const fetchMock = mockFetch({ ok: false, body: { message: "username_taken_in_organization" } });
    renderView({ needsPassword: false, needsUsername: true });
    await waitForCsrf(fetchMock);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("username"), "taken");
    await user.click(screen.getByRole("button", { name: "team_invite_complete_submit" }));

    expect(await screen.findByText("username_taken_in_organization")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
