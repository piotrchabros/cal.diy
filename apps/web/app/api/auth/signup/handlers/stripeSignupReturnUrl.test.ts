import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  WEBAPP_URL: "https://app.example.com",
  WEBAPP_URL_FOR_OAUTH: "https://app.example.com",
  ALLOWED_HOSTNAMES: ["acme.example.org"],
}));

import {
  buildStripeSignupReturnUrl,
  encodeStripeSignupCallbackUrl,
  resolveStripeSignupBaseUrl,
  STRIPE_SIGNUP_CALLBACK_PATH,
} from "./stripeSignupReturnUrl";

describe("stripeSignupReturnUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the Stripe placeholder literal while encoding the callback value", () => {
    const encoded = encodeStripeSignupCallbackUrl("/auth/verify?sessionId={CHECKOUT_SESSION_ID}");

    expect(encoded).toBe("%2Fauth%2Fverify%3FsessionId%3D{CHECKOUT_SESSION_ID}");
    expect(encoded).not.toContain("%7B");
    expect(encoded).not.toContain("%7D");
  });

  it("encodes an absolute callback carrying its own query string as one value", () => {
    const callbackUrl = "https://acme.example.org/settings?tab=billing&ref=premium";

    expect(encodeStripeSignupCallbackUrl(callbackUrl)).toBe(encodeURIComponent(callbackUrl));
  });

  it("builds the return URL with the checkout placeholder in both params", () => {
    const returnUrl = buildStripeSignupReturnUrl("https://app.example.com");

    expect(returnUrl).toContain("checkoutSessionId={CHECKOUT_SESSION_ID}");
    expect(new URL(returnUrl).searchParams.get("callbackUrl")).toBe(STRIPE_SIGNUP_CALLBACK_PATH);
    expect(returnUrl).toContain(`callbackUrl=${encodeStripeSignupCallbackUrl(STRIPE_SIGNUP_CALLBACK_PATH)}`);
  });

  it("keeps a custom absolute callback as a single return URL param", () => {
    const callbackUrl = "https://acme.example.org/settings?tab=billing&ref=premium";
    const returnUrl = buildStripeSignupReturnUrl("https://acme.example.org", callbackUrl);

    expect(new URL(returnUrl).searchParams.get("callbackUrl")).toBe(callbackUrl);
  });

  it("resolves the default domain while organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");

    expect(resolveStripeSignupBaseUrl("acme.example.org")).toBe("https://app.example.com");
  });

  it("resolves the default domain without a host", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    expect(resolveStripeSignupBaseUrl(null)).toBe("https://app.example.com");
    expect(resolveStripeSignupBaseUrl(undefined)).toBe("https://app.example.com");
  });

  it("resolves the organization domain for a known org host", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    expect(resolveStripeSignupBaseUrl("acme.example.org")).toBe("https://acme.example.org");
  });

  it("falls back to the default domain for unknown and loopback hosts", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");

    expect(resolveStripeSignupBaseUrl("evil.example.net")).toBe("https://app.example.com");
    expect(resolveStripeSignupBaseUrl("localhost:3000")).toBe("https://app.example.com");
  });
});
