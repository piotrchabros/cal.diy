import { useBookerUrl } from "@calcom/features/bookings/hooks/useBookerUrl";
import { useOrgBaseUrl } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it } from "vitest";
import { OrgBaseUrlProvider } from "./OrgBaseUrlProvider";

const ORG_VALUE = { baseUrl: "https://cal.bespokesoft.pl", orgSlug: "bespokesoft" };

function wrapper({ children }: { children: React.ReactNode }) {
  return <OrgBaseUrlProvider value={ORG_VALUE}>{children}</OrgBaseUrlProvider>;
}

describe("OrgBaseUrlProvider", () => {
  it("provides the base URL to useOrgBaseUrl", () => {
    expect(renderHook(() => useOrgBaseUrl(), { wrapper }).result.current).toBe(ORG_VALUE.baseUrl);
  });

  it("provides the base URL to useBookerUrl", () => {
    expect(renderHook(() => useBookerUrl(), { wrapper }).result.current).toBe(ORG_VALUE.baseUrl);
  });
});
