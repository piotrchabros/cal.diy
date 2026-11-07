import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useMobileMoreItems } from "./useMobileMoreItems";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { username: "alice", orgAwareUsername: "alice" } } }),
}));

vi.mock("../useBottomNavItems", () => ({
  useBottomNavItems: ({ publicPageUrl }: { publicPageUrl: string }) => [
    { name: "view_public_page", href: publicPageUrl },
    { name: "settings", href: "/settings" },
  ],
}));

describe("useMobileMoreItems", () => {
  it("builds the public page link on the organization host", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OrgBaseUrlContext.Provider value={{ baseUrl: "https://acme.test", orgSlug: "acme" }}>
        {children}
      </OrgBaseUrlContext.Provider>
    );

    const { result } = renderHook(() => useMobileMoreItems(), { wrapper });

    expect(result.current).toEqual([{ name: "view_public_page", href: "https://acme.test/alice" }]);
  });
});
