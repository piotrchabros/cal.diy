import { describe, expect, it } from "vitest";
import { isAllowedPreviewReferrer, isSafeUrlToLoadResourceFrom } from "./previewGuards";

const origins = {
  webappUrl: "https://app.cal.com",
  embedLibUrl: "https://embed.com",
  currentOrigin: "https://app.cal.com",
};

const orgOrigins = { ...origins, currentOrigin: "https://cal.acme.pl" };

describe("isAllowedPreviewReferrer", () => {
  it("allows a referrer on WEBAPP_URL", () => {
    expect(isAllowedPreviewReferrer("https://app.cal.com/event-types/1?tabName=embed", origins)).toBe(true);
    expect(isAllowedPreviewReferrer("https://app.cal.com/event-types/1", orgOrigins)).toBe(true);
  });

  it("allows a referrer on the page's own organization origin", () => {
    expect(isAllowedPreviewReferrer("https://cal.acme.pl/event-types/1?tabName=embed", orgOrigins)).toBe(
      true
    );
  });

  it("refuses a foreign referrer", () => {
    expect(isAllowedPreviewReferrer("https://evil.com/page", orgOrigins)).toBe(false);
    expect(isAllowedPreviewReferrer("https://evil.cal.acme.pl/page", orgOrigins)).toBe(false);
    expect(isAllowedPreviewReferrer("http://cal.acme.pl/page", orgOrigins)).toBe(false);
  });

  it("refuses empty, garbage and opaque referrers", () => {
    expect(isAllowedPreviewReferrer("", orgOrigins)).toBe(false);
    expect(isAllowedPreviewReferrer("not-a-url", orgOrigins)).toBe(false);
    expect(isAllowedPreviewReferrer("data:text/html,hi", { ...orgOrigins, currentOrigin: "null" })).toBe(
      false
    );
  });

  it("does not treat an empty webappUrl as matching everything", () => {
    expect(isAllowedPreviewReferrer("https://evil.com/page", { ...orgOrigins, webappUrl: "" })).toBe(false);
  });
});

describe("isSafeUrlToLoadResourceFrom", () => {
  it("should return true for URLs with same TLD+1 as WEBAPP_URL", () => {
    expect(isSafeUrlToLoadResourceFrom("https://acme.cal.com/path", origins)).toBe(true);
    expect(isSafeUrlToLoadResourceFrom("http://dunder.cal.com?query=1", origins)).toBe(true);
    expect(isSafeUrlToLoadResourceFrom("https://cal.com/path", origins)).toBe(true);
  });

  it("should return true for URLs with same TLD+1 as EMBED_LIB_URL", () => {
    expect(isSafeUrlToLoadResourceFrom("https://test.embed.com/path", origins)).toBe(true);
    expect(isSafeUrlToLoadResourceFrom("http://embed.com/script.js", origins)).toBe(true);
  });

  it("should return true for localhost URLs", () => {
    expect(isSafeUrlToLoadResourceFrom("http://localhost:3000", origins)).toBe(true);
    expect(isSafeUrlToLoadResourceFrom("http://127.0.0.1:3000", origins)).toBe(true);
  });

  it("should return false for different TLD+1", () => {
    expect(isSafeUrlToLoadResourceFrom("https://malicious1.com", origins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("https://malicious2.com", origins)).toBe(false);
  });

  it("should return false for non-http/https protocols", () => {
    expect(isSafeUrlToLoadResourceFrom("ftp://example.com", origins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("javascript:alert(1)", origins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("data:text/html,<script>alert(1)</script>", origins)).toBe(false);
  });

  it("should return false for invalid URLs", () => {
    expect(isSafeUrlToLoadResourceFrom("not-a-url", origins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("http://", origins)).toBe(false);
  });

  it("allows a bookerUrl on the page's own organization origin", () => {
    expect(isSafeUrlToLoadResourceFrom("https://cal.acme.pl", orgOrigins)).toBe(true);
    expect(isSafeUrlToLoadResourceFrom("https://cal.acme.pl/embed/embed.js", orgOrigins)).toBe(true);
  });

  it("refuses a foreign TLD+1 that is not the page's own origin", () => {
    expect(isSafeUrlToLoadResourceFrom("https://other.acme.pl", orgOrigins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("https://cal.acme.pl.evil.com", orgOrigins)).toBe(false);
    expect(isSafeUrlToLoadResourceFrom("http://cal.acme.pl", orgOrigins)).toBe(false);
  });

  it("refuses a non-http protocol even when currentOrigin is opaque", () => {
    expect(isSafeUrlToLoadResourceFrom("data:text/html,hi", { ...orgOrigins, currentOrigin: "null" })).toBe(
      false
    );
  });
});
