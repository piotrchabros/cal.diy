import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";

export interface IExternalCalendarEventsCache {
  get(key: string): NotetakerCalendarEvent[] | null;
  set(key: string, events: NotetakerCalendarEvent[], ttlMs: number): void;
}

type CacheEntry = { events: NotetakerCalendarEvent[]; expiresAt: number };

// Process-local because production has no Redis; a Map keeps insertion order so the oldest entry is
// always the first key, which makes eviction O(1).
export class InMemoryExternalCalendarEventsCache implements IExternalCalendarEventsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { maxEntries: number; now?: () => number }) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  get(key: string): NotetakerCalendarEvent[] | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.events;
  }

  set(key: string, events: NotetakerCalendarEvent[], ttlMs: number): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { events, expiresAt: this.now() + ttlMs });
  }
}
