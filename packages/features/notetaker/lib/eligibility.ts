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

// Maps, not plain records: both are indexed by untrusted strings, and a key like "constructor"
// would otherwise resolve to an inherited function.
const PLATFORM_BY_HOST = new Map<string, NotetakerPlatformDto>([
  ["meet.google.com", "GOOGLE_MEET"],
  ["teams.microsoft.com", "MICROSOFT_TEAMS"],
  ["teams.live.com", "MICROSOFT_TEAMS"],
]);

const PLATFORM_BY_LOCATION_TYPE = new Map<string, NotetakerPlatformDto>([
  [MeetLocationType, "GOOGLE_MEET"],
  [MSTeamsLocationType, "MICROSOFT_TEAMS"],
]);

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

const HTTP_LOCATION = /^https?:\/\//i;

function classifyLink(
  link: string,
  enabledPlatforms: NotetakerPlatformDto[]
): NotetakerStateDto["eligibility"] {
  if (isCalVideoUrl(link)) return ineligible("CAL_VIDEO");
  const platform = classifyMeetingUrl(link);
  if (!platform) return ineligible("UNSUPPORTED_PLATFORM");
  if (!enabledPlatforms.includes(platform)) return ineligible("UNSUPPORTED_PLATFORM", platform);
  return { eligible: true, platform, reason: null };
}

export function classifyMeetingUrl(url: string): NotetakerPlatformDto | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  return PLATFORM_BY_HOST.get(parsed.hostname) ?? null;
}

export function resolveMeetingLink(input: {
  location: string | null;
  metadata: unknown;
  references: MeetingReference[];
}): string | null {
  const { location, metadata, references } = input;

  if (nonBlank(location) === null) return null;
  if (location && HTTP_LOCATION.test(location)) return location;
  if (!location || !PLATFORM_BY_LOCATION_TYPE.has(location)) return null;

  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const videoCallUrl = nonBlank((metadata as Record<string, unknown>).videoCallUrl);
    if (videoCallUrl) return videoCallUrl;
  }

  for (const reference of references) {
    if (reference.deleted === true || !LINK_REFERENCE_TYPES.includes(reference.type)) continue;
    const meetingUrl = nonBlank(reference.meetingUrl);
    if (meetingUrl) return meetingUrl;
  }

  return null;
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

  if (!location || location.trim() === "") return ineligible("UNSUPPORTED_PLATFORM");
  if (location === DailyLocationType) return ineligible("CAL_VIDEO");
  if (HTTP_LOCATION.test(location)) return classifyLink(location, enabledPlatforms);

  const typePlatform = PLATFORM_BY_LOCATION_TYPE.get(location);
  if (!typePlatform) {
    return ineligible(location.startsWith("integrations:") ? "UNSUPPORTED_PLATFORM" : "IN_PERSON_OR_PHONE");
  }

  const link = resolveMeetingLink(input);
  if (link !== null) return classifyLink(link, enabledPlatforms);

  const hasCalVideoReference = references.some(
    (reference) => reference.deleted !== true && reference.type === DAILY_REFERENCE_TYPE
  );
  if (hasCalVideoReference) return ineligible("CAL_VIDEO");

  if (!enabledPlatforms.includes(typePlatform)) return ineligible("UNSUPPORTED_PLATFORM", typePlatform);
  // At booking creation the hook runs before the link is stored, so a supported type without a link
  // is eligible and dispatch resolves the link later.
  return { eligible: true, platform: typePlatform, reason: null };
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
    const platform = PLATFORM_BY_LOCATION_TYPE.get(type);
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
