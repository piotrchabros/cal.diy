import { WEBAPP_URL } from "@calcom/lib/constants";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it } from "vitest";
import { OrgBaseUrlContext } from "../../organizations/lib/OrgBaseUrlContext";
import { useBookerUrl, useEmbedBookerUrl } from "./useBookerUrl";

const ORG_VALUE = { baseUrl: "https://cal.bespokesoft.pl", orgSlug: "bespokesoft" };

function wrapper({ children }: { children: React.ReactNode }) {
  return <OrgBaseUrlContext.Provider value={ORG_VALUE}>{children}</OrgBaseUrlContext.Provider>;
}

describe("useBookerUrl", () => {
  it("returns WEBAPP_URL without a provider", () => {
    expect(renderHook(() => useBookerUrl()).result.current).toBe(WEBAPP_URL);
    expect(renderHook(() => useEmbedBookerUrl()).result.current).toBe(WEBAPP_URL);
  });

  it("returns the organization base URL inside a provider", () => {
    expect(renderHook(() => useBookerUrl(), { wrapper }).result.current).toBe(ORG_VALUE.baseUrl);
    expect(renderHook(() => useEmbedBookerUrl(), { wrapper }).result.current).toBe(ORG_VALUE.baseUrl);
  });
});
