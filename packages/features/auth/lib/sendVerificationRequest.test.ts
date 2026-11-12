import { EMAIL_FROM_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendMail, mockGetOrganizationOriginForUrl, mockResolveForScope } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockGetOrganizationOriginForUrl: vi.fn(),
  mockResolveForScope: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: mockSendMail }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationEmailSenderService.container", () => ({
  getOrganizationEmailSenderService: () => ({ resolveForScope: mockResolveForScope }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = () => "{{{signin_url}}}|{{{base_url}}}|{{email}}";
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock("@calcom/lib/serverConfig", () => ({
  serverConfig: { transport: {}, from: "notifications@cal.example" },
}));

vi.mock("@calcom/features/organizations/lib/getOrganizationOrigin", () => ({
  getOrganizationOriginForUrl: mockGetOrganizationOriginForUrl,
}));

import sendVerificationRequest from "./sendVerificationRequest";

// Delivery is fire-and-forget, so wait for the transport to be reached.
async function sendAndWait(params: { identifier: string; url: string }): Promise<void> {
  await sendVerificationRequest(params);
  await vi.waitFor(() => expect(mockSendMail).toHaveBeenCalled());
}

function sentFroms(): string[] {
  return mockSendMail.mock.calls.map(([payload]) => (payload as { from: string }).from);
}

const NEXTAUTH_URL = "https://app.example.com";
const callbackQuery = "/api/auth/callback/email?callbackUrl=%2F&token=abc&email=a%40b.com";

function sentLink(): string {
  const { html } = mockSendMail.mock.calls[0][0] as { html: string };
  return html.split("|")[0];
}

function sentBaseUrl(): string {
  const { html } = mockSendMail.mock.calls[0][0] as { html: string };
  return html.split("|")[1];
}

describe("sendVerificationRequest", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", NEXTAUTH_URL);
    mockGetOrganizationOriginForUrl.mockResolvedValue(null);
    mockResolveForScope.mockResolvedValue(null);
    mockSendMail.mockImplementation((_payload, callback) => callback(null, {}));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps a link already on NEXTAUTH_URL without an organization lookup", async () => {
    await sendAndWait({ identifier: "a@b.com", url: `${NEXTAUTH_URL}${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
    expect(mockGetOrganizationOriginForUrl).not.toHaveBeenCalled();
  });

  it("rewrites a foreign origin to NEXTAUTH_URL when no organization matches (flag off)", async () => {
    await sendAndWait({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
    expect(mockGetOrganizationOriginForUrl).toHaveBeenCalledWith(`https://cal.acme.com${callbackQuery}`);
  });

  it("keeps a link on an organization's own domain", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendAndWait({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentLink()).toBe(`https://cal.acme.com${callbackQuery}`);
  });

  it("rewrites an unknown host even when another organization origin is returned", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendAndWait({ identifier: "a@b.com", url: `https://evil.com${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
  });

  it("falls back to WEBAPP_URL when NEXTAUTH_URL is unset", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");

    await sendAndWait({ identifier: "a@b.com", url: `https://evil.com${callbackQuery}` });

    expect(sentLink()).toBe(`${new URL(WEBAPP_URL).origin}${callbackQuery}`);
  });

  it("keeps WEBAPP_URL as the asset base URL", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendAndWait({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentBaseUrl()).toBe(WEBAPP_URL);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com" }),
      expect.any(Function)
    );
  });

  it("sends from the display name and bare env address", async () => {
    await sendAndWait({ identifier: "a@b.com", url: `${NEXTAUTH_URL}${callbackQuery}` });

    expect(sentFroms()).toEqual([`${EMAIL_FROM_NAME} <notifications@cal.example>`]);
  });

  it("applies the organization sender resolved for the recipient", async () => {
    mockResolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });

    await sendAndWait({ identifier: "a@b.com", url: `${NEXTAUTH_URL}${callbackQuery}` });

    expect(mockResolveForScope).toHaveBeenCalledWith({ userEmail: "a@b.com" });
    expect(sentFroms()).toEqual(["Acme <hello@acme.com>"]);
  });

  it("catches a delivery error instead of rejecting", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockSendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await expect(
      sendVerificationRequest({ identifier: "a@b.com", url: `${NEXTAUTH_URL}${callbackQuery}` })
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "MAGIC_LINK_EMAIL: failed to send sign-in link",
        expect.any(Error)
      )
    );
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
