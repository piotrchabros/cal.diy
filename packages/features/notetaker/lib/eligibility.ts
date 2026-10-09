import { DailyLocationType, MeetLocationType, MSTeamsLocationType } from "@calcom/app-store/constants";
import type {
  NotetakerIneligibilityReasonDto,
  NotetakerPlatformDto,
  NotetakerStateDto,
} from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerBookingStatus } from "../repositories/interfaces/IBookingNotetakerRepository";

type MeetingReference = { type: string; meetingUrl: string | null; deleted?: boolean | null };

const DAILY_REFERENCE_TYPE = "daily_video";
const LINK_REFERENCE_TYPES = ["google_meet_video", "office365_video", "office365_calendar"];

const PLATFORM_BY_HOST: Record<string, NotetakerPlatformDto> = {
  "meet.google.com": "GOOGLE_MEET",
  "teams.microsoft.com": "MICROSOFT_TEAMS",
  "teams.live.com": "MICROSOFT_TEAMS",
};

const PLATFORM_BY_LOCATION_TYPE: Record<string, NotetakerPlatformDto> = {
  [MeetLocationType]: "GOOGLE_MEET",
  [MSTeamsLocationType]: "MICROSOFT_TEAMS",
};

const PROVISIONAL_STATUSES: NotetakerBookingStatus[] = ["PENDING", "AWAITING_HOST"];

function ineligible(
  reason: NotetakerIneligibilityReasonDto,
  platform: NotetakerPlatformDto | null = null
): NotetakerStateDto["eligibility"] {
  return { eligible: false, platform, reason };
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// WEBAPP_URL is env-derived and these functions must stay pure, so a Cal Video link is recognised
// by shape: a daily.co host, or a /video/<uid> path on a host that is not a supported platform.
function isCalVideoUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const { hostname, pathname } = parsed;
  if (hostname === "daily.co" || hostname.endsWith(".daily.co")) return true;
  return /^\/video\/[^/]+\/?$/.test(pathname) && classifyMeetingUrl(url) === null;
}

export function classifyMeetingUrl(url: string): NotetakerPlatformDto | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  return PLATFORM_BY_HOST[parsed.hostname] ?? null;
}

export function resolveMeetingLink(input: {
  location: string | null;
  metadata: unknown;
  references: MeetingReference[];
}): string | null {
  const { location, metadata, references } = input;

  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const videoCallUrl = nonBlank((metadata as Record<string, unknown>).videoCallUrl);
    if (videoCallUrl) return videoCallUrl;
  }

  for (const reference of references) {
    if (reference.deleted === true || !LINK_REFERENCE_TYPES.includes(reference.type)) continue;
    const meetingUrl = nonBlank(reference.meetingUrl);
    if (meetingUrl) return meetingUrl;
  }

  return location && /^https?:\/\//i.test(location) ? location : null;
}

export function getBookingNotetakerEligibility(input: {
  location: string | null;
  metadata: unknown;
  references: MeetingReference[];
  bookingStatus: NotetakerBookingStatus;
  enabledPlatforms: NotetakerPlatformDto[];
}): NotetakerStateDto["eligibility"] {
  const { location, references, bookingStatus, enabledPlatforms } = input;

  if (bookingStatus === "CANCELLED" || bookingStatus === "REJECTED") {
    return ineligible("BOOKING_NOT_ACTIVE");
  }

  const link = resolveMeetingLink(input);

  const isCalVideo =
    location === DailyLocationType ||
    references.some((reference) => reference.deleted !== true && reference.type === DAILY_REFERENCE_TYPE) ||
    (link !== null && isCalVideoUrl(link));
  if (isCalVideo) return ineligible("CAL_VIDEO");

  if (link !== null) {
    const platform = classifyMeetingUrl(link);
    if (!platform) return ineligible("UNSUPPORTED_PLATFORM");
    if (!enabledPlatforms.includes(platform)) return ineligible("UNSUPPORTED_PLATFORM", platform);
    return { eligible: true, platform, reason: null };
  }

  const locationPlatform = location ? (PLATFORM_BY_LOCATION_TYPE[location] ?? null) : null;
  if (locationPlatform) {
    if (!enabledPlatforms.includes(locationPlatform)) {
      return ineligible("UNSUPPORTED_PLATFORM", locationPlatform);
    }
    // Before confirmation the conferencing link does not exist yet, so eligibility is only provisional.
    if (PROVISIONAL_STATUSES.includes(bookingStatus)) {
      return { eligible: true, platform: locationPlatform, reason: null };
    }
    // Dispatch relies on the platform being set whenever the reason is NO_MEETING_LINK.
    return ineligible("NO_MEETING_LINK", locationPlatform);
  }

  if (!location || location.trim() === "" || location.startsWith("integrations:")) {
    return ineligible("UNSUPPORTED_PLATFORM");
  }
  return ineligible("IN_PERSON_OR_PHONE");
}

export function getEventTypeNotetakerAvailability(input: {
  locations: { type: string }[];
  enabledPlatforms: NotetakerPlatformDto[];
}): {
  available: boolean;
  unavailableReason: NotetakerIneligibilityReasonDto | null;
  supportedLocationTypes: string[];
} {
  const { locations, enabledPlatforms } = input;

  const supportedLocationTypes: string[] = [];
  for (const { type } of locations) {
    const platform = PLATFORM_BY_LOCATION_TYPE[type];
    if (platform && enabledPlatforms.includes(platform) && !supportedLocationTypes.includes(type)) {
      supportedLocationTypes.push(type);
    }
  }

  if (supportedLocationTypes.length > 0) {
    return { available: true, unavailableReason: null, supportedLocationTypes };
  }

  // An empty list counts as Cal Video: Cal.com stores an empty location as DailyLocationType.
  const everyLocationIsCalVideo = locations.every(({ type }) => type === DailyLocationType);
  return {
    available: false,
    unavailableReason: everyLocationIsCalVideo ? "CAL_VIDEO" : "UNSUPPORTED_PLATFORM",
    supportedLocationTypes,
  };
}
