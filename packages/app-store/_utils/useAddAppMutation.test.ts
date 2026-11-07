// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useAddAppMutation from "./useAddAppMutation";

vi.mock("next/navigation", () => ({
  usePathname: () => "/apps/installed/calendar",
}));

describe("useAddAppMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds onErrorReturnTo from the current origin so org-domain users return to their own host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: "installed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useAddAppMutation("google_calendar"), { wrapper });

    act(() => {
      result.current.mutate("");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const requestUrl = new URL(fetchMock.mock.calls[0][0], window.location.origin);
    expect(requestUrl.pathname).toBe("/api/integrations/google_calendar/add");
    const state = JSON.parse(requestUrl.searchParams.get("state") ?? "{}");
    expect(state.onErrorReturnTo).toBe(`${window.location.origin}/apps/installed/calendar`);
  });
});
