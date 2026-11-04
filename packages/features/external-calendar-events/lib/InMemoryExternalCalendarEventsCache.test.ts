import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";
import { describe, expect, it } from "vitest";
import { InMemoryExternalCalendarEventsCache } from "./InMemoryExternalCalendarEventsCache";

function buildEvent(externalId: string): NotetakerCalendarEvent {
  return {
    externalId,
    iCalUID: null,
    recurringEventId: null,
    title: null,
    start: new Date("2026-11-04T10:00:00.000Z"),
    end: new Date("2026-11-04T11:00:00.000Z"),
    isAllDay: false,
    status: "confirmed",
    selfResponse: null,
    organizerEmail: null,
    attendeeEmails: [],
    candidateLinks: [],
  };
}

function buildCache(maxEntries = 500) {
  let clock = 1_000;
  const cache = new InMemoryExternalCalendarEventsCache({ maxEntries, now: () => clock });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { cache, advance };
}

describe("InMemoryExternalCalendarEventsCache", () => {
  it("returns null for an unknown key", () => {
    const { cache } = buildCache();

    expect(cache.get("missing")).toBeNull();
  });

  it("returns the stored events until the ttl elapses", () => {
    const { cache, advance } = buildCache();
    const events = [buildEvent("e-1")];

    cache.set("k", events, 60_000);
    advance(59_999);
    expect(cache.get("k")).toBe(events);

    advance(1);
    expect(cache.get("k")).toBeNull();
  });

  it("overwriting a key renews its ttl", () => {
    const { cache, advance } = buildCache();

    cache.set("k", [buildEvent("e-1")], 1_000);
    advance(900);
    const fresh = [buildEvent("e-2")];
    cache.set("k", fresh, 1_000);
    advance(900);

    expect(cache.get("k")).toBe(fresh);
  });

  it("evicts the oldest entry once maxEntries is reached", () => {
    const { cache } = buildCache(2);

    cache.set("a", [buildEvent("a")], 60_000);
    cache.set("b", [buildEvent("b")], 60_000);
    cache.set("c", [buildEvent("c")], 60_000);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  it("treats an overwritten key as the newest entry when evicting", () => {
    const { cache } = buildCache(2);

    cache.set("a", [buildEvent("a")], 60_000);
    cache.set("b", [buildEvent("b")], 60_000);
    cache.set("a", [buildEvent("a2")], 60_000);
    cache.set("c", [buildEvent("c")], 60_000);

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });
});
