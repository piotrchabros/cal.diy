import { OrgBaseUrlContext } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRedirectToLoginIfUnauthenticated } from "./useRedirectToLoginIfUnauthenticated";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <OrgBaseUrlContext.Provider value={{ baseUrl: "https://acme.test", orgSlug: "acme" }}>
    {children}
  </OrgBaseUrlContext.Provider>
);

describe("useRedirectToLoginIfUnauthenticated", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("builds the login callbackUrl from the organization base URL", () => {
    renderHook(() => useRedirectToLoginIfUnauthenticated(), { wrapper });

    expect(replace).toHaveBeenCalledTimes(1);
    const target = new URL(replace.mock.calls[0][0], "https://placeholder.test");
    expect(target.pathname).toBe("/auth/login");
    expect(target.searchParams.get("callbackUrl")?.startsWith("https://acme.test")).toBe(true);
  });

  it("does not redirect on public pages", () => {
    renderHook(() => useRedirectToLoginIfUnauthenticated(true), { wrapper });

    expect(replace).not.toHaveBeenCalled();
  });
});
