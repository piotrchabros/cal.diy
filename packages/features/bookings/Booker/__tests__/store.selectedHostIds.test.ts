import { SELECTED_HOSTS_QUERY_PARAM } from "@calcom/features/eventtypes/lib/bookerHostSelection";
import { beforeEach, describe, expect, it } from "vitest";
import { useBookerStore } from "../store";

const initialize = (eventSlug: string, extra: Record<string, unknown> = {}) =>
  useBookerStore.getState().initialize({
    username: "team",
    eventSlug,
    eventId: undefined,
    layout: "month_view",
    month: "2030-01",
    ...extra,
  } as Parameters<ReturnType<typeof useBookerStore.getState>["initialize"]>[0]);

describe("booker store selectedHostIds", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    useBookerStore.setState({ selectedHostIds: null, eventSlug: null, eventId: null });
  });

  it("writes the hosts to the URL and clears them when set to null", () => {
    useBookerStore.getState().setSelectedHostIds([3, 5]);
    expect(useBookerStore.getState().selectedHostIds).toEqual([3, 5]);
    expect(new URLSearchParams(window.location.search).get(SELECTED_HOSTS_QUERY_PARAM)).toBe("3,5");

    useBookerStore.getState().setSelectedHostIds(null);
    expect(useBookerStore.getState().selectedHostIds).toBeNull();
    expect(new URLSearchParams(window.location.search).has(SELECTED_HOSTS_QUERY_PARAM)).toBe(false);
  });

  it("does not touch the URL on platform when updating URL params is disallowed", () => {
    useBookerStore.setState({ isPlatform: true, allowUpdatingUrlParams: false });
    useBookerStore.getState().setSelectedHostIds([1]);
    expect(useBookerStore.getState().selectedHostIds).toEqual([1]);
    expect(window.location.search).toBe("");
    useBookerStore.setState({ isPlatform: false, allowUpdatingUrlParams: true });
  });

  it("keeps hosts across the first initialize and resets them when the event changes", () => {
    initialize("first");
    useBookerStore.getState().setSelectedHostIds([2]);
    initialize("first", { month: "2030-02" });
    expect(useBookerStore.getState().selectedHostIds).toEqual([2]);

    initialize("second");
    expect(useBookerStore.getState().selectedHostIds).toBeNull();
    expect(new URLSearchParams(window.location.search).has(SELECTED_HOSTS_QUERY_PARAM)).toBe(false);
  });
});
