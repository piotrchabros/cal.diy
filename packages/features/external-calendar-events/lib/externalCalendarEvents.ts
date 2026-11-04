import { parseAdHocMeetingUrl } from "@calcom/features/notetaker/lib/adHocMeeting";
import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";
import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";

export const EXTERNAL_CALENDAR_EVENTS_FEATURE_SLUG = "bookings-external-calendar-events";
export const ALL_NOTETAKER_PLATFORMS: readonly NotetakerPlatformDto[] = ["GOOGLE_MEET", "MICROSOFT_TEAMS"];
export const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000;

export type ExternalCalendarRef = {
  selectedCalendarId: string;
  integration: string;
  externalId: string;
  credentialId: number | null;
  delegationCredentialId: string | null;
};

export type CalendarEventEntry = { calendar: ExternalCalendarRef; event: NotetakerCalendarEvent };

export type SupportedMeetingLink = { meetingUrl: string; platform: NotetakerPlatformDto };

export type CalDiyMatchSets = {
  iCalUIDs: Set<string>;
  referenceUids: Set<string>;
  // `${selectedCalendarId}:${externalEventId}`
  participantEventKeys: Set<string>;
  bookedLocations: { location: string; startTime: Date; endTime: Date }[];
};

// The same event shows up in every calendar the user is invited through, so the first one wins.
export function selectVisibleEntries(entries: CalendarEventEntry[]): CalendarEventEntry[] {
  const seen = new Set<string>();
  const result: CalendarEventEntry[] = [];
  for (const entry of entries) {
    const { event } = entry;
    if (event.status === "cancelled" || event.selfResponse === "declined") continue;
    const dedupeKey = `${event.iCalUID ?? event.externalId}|${event.start.getTime()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(entry);
  }
  return result;
}

export function findSupportedMeetingLink(candidateLinks: string[]): SupportedMeetingLink | null {
  for (const link of candidateLinks) {
    const parsed = parseAdHocMeetingUrl(link, ALL_NOTETAKER_PLATFORMS);
    if (parsed.ok) return { meetingUrl: parsed.meetingUrl, platform: parsed.platform };
  }
  return null;
}

export function isRepresentedInCalDiy(
  entry: CalendarEventEntry,
  meetingUrl: string | null,
  sets: CalDiyMatchSets
): boolean {
  const { calendar, event } = entry;
  if (event.iCalUID && sets.iCalUIDs.has(event.iCalUID)) return true;
  if (sets.referenceUids.has(event.externalId)) return true;
  if (event.recurringEventId && sets.referenceUids.has(event.recurringEventId)) return true;
  if (sets.participantEventKeys.has(`${calendar.selectedCalendarId}:${event.externalId}`)) return true;
  if (!meetingUrl) return false;
  return sets.bookedLocations.some(
    (item) => item.location === meetingUrl && event.start < item.endTime && event.end > item.startTime
  );
}

export function toExternalCalendarEventDto(
  entry: CalendarEventEntry,
  link: SupportedMeetingLink | null
): ExternalCalendarEventDto {
  const { calendar, event } = entry;
  return {
    key: `${calendar.selectedCalendarId}:${event.externalId}`,
    title: event.title,
    start: event.start,
    end: event.end,
    isAllDay: event.isAllDay,
    status: event.status === "tentative" ? "tentative" : "confirmed",
    selfResponse: event.selfResponse === "declined" ? null : event.selfResponse,
    attendeesCount: event.attendeeEmails.length,
    meetingUrl: link?.meetingUrl ?? null,
    meetingPlatform: link?.platform ?? null,
    calendar: {
      selectedCalendarId: calendar.selectedCalendarId,
      integration: calendar.integration,
      externalId: calendar.externalId,
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
