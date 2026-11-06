import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendMail, mockGetOrganizationOriginForUrl } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockGetOrganizationOriginForUrl: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = () => "{{{signin_url}}}|{{{base_url}}}|{{email}}";
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock("@calcom/lib/serverConfig", () => ({
  serverConfig: { transport: {} },
}));

vi.mock("@calcom/features/organizations/lib/getOrganizationOrigin", () => ({
  getOrganizationOriginForUrl: mockGetOrganizationOriginForUrl,
}));

import sendVerificationRequest from "./sendVerificationRequest";

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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps a link already on NEXTAUTH_URL without an organization lookup", async () => {
    await sendVerificationRequest({ identifier: "a@b.com", url: `${NEXTAUTH_URL}${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
    expect(mockGetOrganizationOriginForUrl).not.toHaveBeenCalled();
  });

  it("rewrites a foreign origin to NEXTAUTH_URL when no organization matches (flag off)", async () => {
    await sendVerificationRequest({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
    expect(mockGetOrganizationOriginForUrl).toHaveBeenCalledWith(`https://cal.acme.com${callbackQuery}`);
  });

  it("keeps a link on an organization's own domain", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendVerificationRequest({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentLink()).toBe(`https://cal.acme.com${callbackQuery}`);
  });

  it("rewrites an unknown host even when another organization origin is returned", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendVerificationRequest({ identifier: "a@b.com", url: `https://evil.com${callbackQuery}` });

    expect(sentLink()).toBe(`${NEXTAUTH_URL}${callbackQuery}`);
  });

  it("falls back to WEBAPP_URL when NEXTAUTH_URL is unset", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");

    await sendVerificationRequest({ identifier: "a@b.com", url: `https://evil.com${callbackQuery}` });

    expect(sentLink()).toBe(`${new URL(WEBAPP_URL).origin}${callbackQuery}`);
  });

  it("keeps WEBAPP_URL as the asset base URL", async () => {
    mockGetOrganizationOriginForUrl.mockResolvedValue("https://cal.acme.com");

    await sendVerificationRequest({ identifier: "a@b.com", url: `https://cal.acme.com${callbackQuery}` });

    expect(sentBaseUrl()).toBe(WEBAPP_URL);
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@b.com" }));
  });
});
