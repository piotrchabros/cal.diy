import { WEBAPP_URL } from "@calcom/lib/constants";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it } from "vitest";
import { OrgBaseUrlContext, type OrgBaseUrlContextValue, useOrgBaseUrl, useOrgBaseUrlOr } from "./OrgBaseUrlContext";

const wrapperFor =
  (value: OrgBaseUrlContextValue) =>
  ({ children }: { children: React.ReactNode }) => (
    <OrgBaseUrlContext.Provider value={value}>{children}</OrgBaseUrlContext.Provider>
  );

describe("useOrgBaseUrl", () => {
  it("defaults to WEBAPP_URL without a provider", () => {
    expect(renderHook(() => useOrgBaseUrl()).result.current).toBe(WEBAPP_URL);
  });

  it("returns the provided base URL", () => {
    const { result } = renderHook(() => useOrgBaseUrl(), {
      wrapper: wrapperFor({ baseUrl: "https://acme.test", orgSlug: "acme" }),
    });
    expect(result.current).toBe("https://acme.test");
  });
});

describe("useOrgBaseUrlOr", () => {
  it("returns the organization base URL on an organization host", () => {
    const { result } = renderHook(() => useOrgBaseUrlOr("https://website.test"), {
      wrapper: wrapperFor({ baseUrl: "https://acme.test", orgSlug: "acme" }),
    });
    expect(result.current).toBe("https://acme.test");
  });

  it("returns the fallback without an organization", () => {
    const { result } = renderHook(() => useOrgBaseUrlOr("https://website.test"), {
      wrapper: wrapperFor({ baseUrl: "https://app.test", orgSlug: null }),
    });
    expect(result.current).toBe("https://website.test");
  });

  it("keeps an undefined fallback", () => {
    expect(renderHook(() => useOrgBaseUrlOr(undefined)).result.current).toBeUndefined();
  });
});
