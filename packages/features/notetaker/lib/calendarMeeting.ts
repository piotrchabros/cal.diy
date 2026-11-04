import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { parseAdHocMeetingUrl } from "./adHocMeeting";

// Stored in Booking.metadata, which only allows string values.
export const NOTETAKER_CALENDAR_MEETING_KEY = "notetakerCalendarMeeting";

export type NotetakerCalendarEvent = {
  externalId: string;
  iCalUID: string | null;
  recurringEventId: string | null;
  title: string | null;
  start: Date;
  end: Date;
  isAllDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  selfResponse: "accepted" | "tentative" | "needsAction" | "declined" | "organizer" | null;
  organizerEmail: string | null;
  attendeeEmails: string[];
  // Ordered by trust: conference link first, then location, then links found in free text.
  candidateLinks: string[];
};

export type NotetakerCalendarSkipReason =
  | "CANCELLED"
  | "DECLINED"
  | "NOT_ACCEPTED"
  | "ALL_DAY"
  | "ENDED"
  | "NO_SUPPORTED_LINK"
  | "NO_OTHER_ATTENDEES";

export type NotetakerCalendarEventDecision =
  | { join: true; platform: NotetakerPlatformDto; meetingUrl: string; meetingKey: string }
  | { join: false; reason: NotetakerCalendarSkipReason };

const TEXT_URL = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function skip(reason: NotetakerCalendarSkipReason): NotetakerCalendarEventDecision {
  return { join: false, reason };
}

function isAcceptedOrOrganizer(event: NotetakerCalendarEvent, selfEmails: ReadonlySet<string>): boolean {
  if (event.selfResponse === null) {
    // Some calendars omit the self attendee on events the user created.
    return event.organizerEmail !== null && selfEmails.has(event.organizerEmail.toLowerCase());
  }
  return event.selfResponse === "accepted" || event.selfResponse === "organizer";
}

export function buildMeetingKey(platform: NotetakerPlatformDto, canonicalUrl: string): string {
  return `${platform}:${canonicalUrl}`;
}

export function decideCalendarEvent(
  event: NotetakerCalendarEvent,
  opts: { now: Date; enabledPlatforms: readonly NotetakerPlatformDto[]; selfEmails: string[] }
): NotetakerCalendarEventDecision {
  const selfEmails = new Set(opts.selfEmails.map((email) => email.toLowerCase()));

  if (event.status === "cancelled") return skip("CANCELLED");
  if (event.isAllDay) return skip("ALL_DAY");
  if (event.end.getTime() <= opts.now.getTime()) return skip("ENDED");
  if (event.selfResponse === "declined") return skip("DECLINED");
  if (!isAcceptedOrOrganizer(event, selfEmails)) return skip("NOT_ACCEPTED");
  if (!event.attendeeEmails.some((email) => !selfEmails.has(email.toLowerCase()))) {
    return skip("NO_OTHER_ATTENDEES");
  }

  for (const link of event.candidateLinks) {
    const parsed = parseAdHocMeetingUrl(link, opts.enabledPlatforms);
    if (!parsed.ok) continue;
    return {
      join: true,
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      meetingKey: buildMeetingKey(parsed.platform, parsed.meetingUrl),
    };
  }
  return skip("NO_SUPPORTED_LINK");
}

// Entities are decoded before matching so an href="...&amp;..." in an HTML body yields the real query string.
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

export function extractMeetingLinksFromText(text: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of Array.from(decodeEntities(text).matchAll(TEXT_URL))) {
    const link = match[0].replace(TRAILING_PUNCTUATION, "");
    if (link.length === 0 || seen.has(link)) continue;
    seen.add(link);
    links.push(link);
  }
  return links;
}
