import { describe, expect, it, vi } from "vitest";
import { getSafeRedirectUrl } from "./getSafeRedirectUrl";

vi.mock("./constants", () => ({
  CONSOLE_URL: "https://console.cal.com",
  WEBAPP_URL: "https://app.cal.com",
  WEBSITE_URL: "https://cal.com",
}));

describe("getSafeRedirectUrl", () => {
  it("returns null for an empty URL", () => {
    expect(getSafeRedirectUrl()).toBeNull();
    expect(getSafeRedirectUrl("")).toBeNull();
  });

  it("throws for a relative URL", () => {
    expect(() => getSafeRedirectUrl("/bookings")).toThrow("Pass an absolute URL");
    expect(() => getSafeRedirectUrl("//evil.com/path")).toThrow("Pass an absolute URL");
    expect(() => getSafeRedirectUrl("/bookings", { allowedOrigins: ["https://cal.acme.com"] })).toThrow(
      "Pass an absolute URL"
    );
  });

  it("keeps URLs on the console, webapp and website origins", () => {
    expect(getSafeRedirectUrl("https://app.cal.com/bookings?x=1")).toBe("https://app.cal.com/bookings?x=1");
    expect(getSafeRedirectUrl("https://console.cal.com/a")).toBe("https://console.cal.com/a");
    expect(getSafeRedirectUrl("https://cal.com/pricing")).toBe("https://cal.com/pricing");
  });

  it("falls back to the webapp root for other origins by default", () => {
    expect(getSafeRedirectUrl("https://evil.com/phish")).toBe("https://app.cal.com/");
    expect(getSafeRedirectUrl("https://acme.cal.com/x")).toBe("https://app.cal.com/");
  });

  it("allows an extra origin passed in allowedOrigins", () => {
    expect(
      getSafeRedirectUrl("https://cal.acme.com/team/x", { allowedOrigins: ["https://cal.acme.com"] })
    ).toBe("https://cal.acme.com/team/x");
  });

  it("compares extra origins exactly", () => {
    const options = { allowedOrigins: ["https://cal.acme.com"] };
    expect(getSafeRedirectUrl("https://evil.cal.acme.com/x", options)).toBe("https://app.cal.com/");
    expect(getSafeRedirectUrl("https://cal.acme.com.evil.com/x", options)).toBe("https://app.cal.com/");
    expect(getSafeRedirectUrl("https://cal.acme.com:8443/x", options)).toBe("https://app.cal.com/");
  });

  it("rejects a protocol mismatch with an allowed origin", () => {
    expect(getSafeRedirectUrl("http://cal.acme.com/x", { allowedOrigins: ["https://cal.acme.com"] })).toBe(
      "https://app.cal.com/"
    );
  });

  it("ignores invalid and opaque allowedOrigins entries", () => {
    const options = { allowedOrigins: ["not a url", "", "data:text/html,hi", "https://cal.acme.com"] };
    expect(getSafeRedirectUrl("https://evil.com/x", options)).toBe("https://app.cal.com/");
    expect(getSafeRedirectUrl("https://cal.acme.com/x", options)).toBe("https://cal.acme.com/x");
  });

  it("uses fallbackUrl for disallowed origins", () => {
    expect(getSafeRedirectUrl("https://evil.com/x", { fallbackUrl: "https://cal.acme.com/" })).toBe(
      "https://cal.acme.com/"
    );
    expect(getSafeRedirectUrl("https://app.cal.com/x", { fallbackUrl: "https://cal.acme.com/" })).toBe(
      "https://app.cal.com/x"
    );
  });
});
