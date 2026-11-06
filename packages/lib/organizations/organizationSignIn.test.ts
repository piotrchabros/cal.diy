import { describe, expect, it } from "vitest";
import {
  buildOrganizationLoginUrl,
  buildWrongOrganizationDomainErrorUrl,
  isOrganizationLoginRedirect,
  SIGN_IN_REASON_PARAM,
  WRONG_ORGANIZATION_DOMAIN_ERROR,
} from "./organizationSignIn";

describe("buildOrganizationLoginUrl", () => {
  it.each([
    ["https://cal.acme.com", "https://cal.acme.com/auth/login?reason=wrong_organization_domain"],
    ["https://cal.acme.com/", "https://cal.acme.com/auth/login?reason=wrong_organization_domain"],
    ["http://localhost:3000", "http://localhost:3000/auth/login?reason=wrong_organization_domain"],
  ])("builds the login URL for %s", (baseUrl, expected) => {
    expect(buildOrganizationLoginUrl(baseUrl)).toBe(expected);
  });

  it("does not carry an error param", () => {
    expect(new URL(buildOrganizationLoginUrl("https://cal.acme.com")).searchParams.has("error")).toBe(false);
  });
});

describe("buildWrongOrganizationDomainErrorUrl", () => {
  it.each([
    ["https://cal.acme.com", "https://cal.acme.com/auth/error?error=wrong_organization_domain"],
    ["https://cal.acme.com/", "https://cal.acme.com/auth/error?error=wrong_organization_domain"],
  ])("builds the error URL for %s", (baseUrl, expected) => {
    expect(buildWrongOrganizationDomainErrorUrl(baseUrl)).toBe(expected);
  });
});

describe("isOrganizationLoginRedirect", () => {
  it.each([
    buildOrganizationLoginUrl("https://cal.acme.com"),
    buildOrganizationLoginUrl("http://localhost:3000"),
    `https://cal.acme.com/auth/login?callbackUrl=%2F&${SIGN_IN_REASON_PARAM}=${WRONG_ORGANIZATION_DOMAIN_ERROR}`,
  ])("returns true for %s", (url) => {
    expect(isOrganizationLoginRedirect(url)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "",
    "not a url",
    "/auth/login?reason=wrong_organization_domain",
    "javascript://cal.acme.com/auth/login?reason=wrong_organization_domain",
    "https://cal.acme.com/auth/login",
    "https://cal.acme.com/auth/login?reason=other",
    "https://cal.acme.com/auth/error?error=wrong_organization_domain",
    "https://cal.acme.com/auth/login/extra?reason=wrong_organization_domain",
  ])("returns false for %j", (url) => {
    expect(isOrganizationLoginRedirect(url)).toBe(false);
  });
});
