import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerAdHocBookingWithLatestSessionRecord } from "../repositories/interfaces/IBookingNotetakerRepository";
import { classifyMeetingUrl } from "./eligibility";
import { NOTETAKER_LIVE_SESSION_STATUSES } from "./sessionStateMachine";

const GOOGLE_MEET_HOST = "meet.google.com";
const TEAMS_HOST = "teams.microsoft.com";
// Meet also serves a meeting under /meet/<code>, which some apps and invites link to.
const MEET_CODE_PATH = /^(?:\/meet)?\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;
const TEAMS_LONG_PATH = /^\/l\/meetup-join\/([^/]+)\/([0-9]{1,20})\/?$/;
const TEAMS_THREAD_ID = /^19:[\w.@-]+$/;
const TEAMS_SHORT_PATH = /^\/meet\/([0-9]{6,20})\/?$/;
const TEAMS_PASSCODE = /^[A-Za-z0-9]{1,64}$/;
const TEAMS_LAUNCHER_PATH = "/dl/launcher/launcher.html";
const TEAMS_LAUNCHER_PREFIX = "/_#/l/meetup-join/";
const MIMECAST_HOST = /^protect(?:-[a-z]{2})?\.mimecast\.com$/;
const URLDEFENSE_HOSTS: readonly string[] = ["urldefense.com", "urldefense.proofpoint.com"];
// Government clouds and the new teams.cloud.microsoft domain are not accepted by Recall's bot.
const UNSUPPORTED_TEAMS_HOSTS: readonly string[] = [
  "teams.microsoft.us",
  "gov.teams.microsoft.us",
  "dod.teams.microsoft.us",
  "teams.cloud.microsoft",
];
const MAX_MEETING_URL_LENGTH = 2048;
const MAX_TEAMS_THREAD_LENGTH = 256;
const MAX_TEAMS_CONTEXT_LENGTH = 1024;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const INVISIBLE_FORMAT_CHARACTERS = new RegExp("\\p{Cf}", "gu");

export const NOTETAKER_AD_HOC_KEY = "notetakerAdHoc";
export const NOTETAKER_AD_HOC_SHARING_TEAM_KEY = "notetakerSharingTeamId";

export type AdHocMeetingUrlRejection =
  | "INVALID_MEETING_LINK"
  | "UNSUPPORTED_PLATFORM"
  | "WRAPPED_MEETING_LINK";

export type AdHocMeetingUrlResult =
  | { ok: true; platform: NotetakerPlatformDto; meetingUrl: string }
  | { ok: false; reason: AdHocMeetingUrlRejection };

const INVALID = { ok: false, reason: "INVALID_MEETING_LINK" } as const;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTenantId(context: string): boolean {
  try {
    const parsed: unknown = JSON.parse(context);
    return isPlainObject(parsed) && typeof parsed.Tid === "string";
  } catch {
    return false;
  }
}

// Unwrapping a security wrapper would mean trusting its query string, so the user is asked for the original.
function isWrapperHost(host: string): boolean {
  return (
    host.endsWith(".safelinks.protection.outlook.com") ||
    URLDEFENSE_HOSTS.includes(host) ||
    MIMECAST_HOST.test(host)
  );
}

// Links copied from chat apps and documents often carry zero-width or direction marks that the URL
// parser rejects; they are never part of a real meeting link.
export function cleanMeetingLinkInput(raw: string): string {
  return raw.replace(INVISIBLE_FORMAT_CHARACTERS, "").trim();
}

function parseMeetUrl(parsed: URL): AdHocMeetingUrlResult {
  const code = MEET_CODE_PATH.exec(parsed.pathname)?.[1];
  if (!code) return INVALID;
  return {
    ok: true,
    platform: "GOOGLE_MEET",
    meetingUrl: `https://${GOOGLE_MEET_HOST}/${code.toLowerCase()}`,
  };
}

function parseTeamsLongLink(parsed: URL): AdHocMeetingUrlResult {
  if (parsed.hostname !== TEAMS_HOST) return INVALID;
  const match = TEAMS_LONG_PATH.exec(parsed.pathname);
  if (!match) return INVALID;
  const thread = safeDecode(match[1]);
  const messageId = match[2];
  if (thread === null || thread.length > MAX_TEAMS_THREAD_LENGTH || !TEAMS_THREAD_ID.test(thread)) {
    return INVALID;
  }
  const context = parsed.searchParams.get("context");
  if (!context || context.length > MAX_TEAMS_CONTEXT_LENGTH || !hasTenantId(context)) return INVALID;
  return {
    ok: true,
    platform: "MICROSOFT_TEAMS",
    meetingUrl: `https://${TEAMS_HOST}/l/meetup-join/${encodeURIComponent(thread)}/${messageId}?context=${encodeURIComponent(context)}`,
  };
}

function parseTeamsUrl(parsed: URL): AdHocMeetingUrlResult {
  const host = parsed.hostname;
  const shortId = TEAMS_SHORT_PATH.exec(parsed.pathname)?.[1];
  if (shortId) {
    const passcode = parsed.searchParams.get("p");
    if (!passcode || !TEAMS_PASSCODE.test(passcode)) return INVALID;
    return {
      ok: true,
      platform: "MICROSOFT_TEAMS",
      meetingUrl: `https://${host}/meet/${shortId}?p=${passcode}`,
    };
  }

  if (host === TEAMS_HOST && parsed.pathname === TEAMS_LAUNCHER_PATH) {
    const target = parsed.searchParams.get("url");
    if (!target?.startsWith(TEAMS_LAUNCHER_PREFIX)) return INVALID;
    // The launcher wraps the long link behind "/_#"; it is unwrapped exactly once, never recursively.
    const inner = parseUrl(`https://${TEAMS_HOST}${target.slice(3)}`);
    if (!inner || inner.hostname !== TEAMS_HOST) return INVALID;
    return parseTeamsLongLink(inner);
  }

  return parseTeamsLongLink(parsed);
}

// The bot joins whatever URL we store, so only exact platform hosts with a recognised meeting shape are
// accepted and the stored link is rebuilt from the validated parts; userinfo and ports are rejected
// because they can make a look-alike URL resolve elsewhere.
export function parseAdHocMeetingUrl(
  raw: string,
  enabledPlatforms: readonly NotetakerPlatformDto[]
): AdHocMeetingUrlResult {
  const cleaned = cleanMeetingLinkInput(raw);
  if (cleaned.length > MAX_MEETING_URL_LENGTH) return INVALID;
  const parsed = parseUrl(cleaned);
  if (!parsed) return INVALID;
  if (parsed.protocol !== "https:") return INVALID;
  if (parsed.username || parsed.password || parsed.port) return INVALID;

  const host = parsed.hostname;
  if (isWrapperHost(host)) return { ok: false, reason: "WRAPPED_MEETING_LINK" };
  if (UNSUPPORTED_TEAMS_HOSTS.includes(host)) return { ok: false, reason: "UNSUPPORTED_PLATFORM" };

  const platform = classifyMeetingUrl(parsed.href);
  if (!platform) return INVALID;
  if (!enabledPlatforms.includes(platform)) return { ok: false, reason: "UNSUPPORTED_PLATFORM" };

  return platform === "GOOGLE_MEET" ? parseMeetUrl(parsed) : parseTeamsUrl(parsed);
}

// Booking.metadata only allows string values, so both fields are stored as strings.
export function buildAdHocBookingMetadata(p: { sharingTeamId: number | null }): Record<string, string> {
  const metadata: Record<string, string> = { [NOTETAKER_AD_HOC_KEY]: "true" };
  if (p.sharingTeamId !== null) metadata[NOTETAKER_AD_HOC_SHARING_TEAM_KEY] = String(p.sharingTeamId);
  return metadata;
}

export function readAdHocBookingMetadata(metadata: unknown): {
  isAdHoc: boolean;
  sharingTeamId: number | null;
} {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { isAdHoc: false, sharingTeamId: null };
  }
  const record = metadata as Record<string, unknown>;
  const rawTeamId = record[NOTETAKER_AD_HOC_SHARING_TEAM_KEY];
  const teamId = typeof rawTeamId === "string" && POSITIVE_INTEGER.test(rawTeamId) ? Number(rawTeamId) : null;
  return {
    isAdHoc: record[NOTETAKER_AD_HOC_KEY] === "true",
    sharingTeamId: teamId !== null && Number.isSafeInteger(teamId) ? teamId : null,
  };
}

// A booking without a session and without a disabled choice is still being dispatched, so it counts
// as live; once the latest bot finished it stops counting unless the choice was armed again.
export function isAdHocMeetingActive(
  meeting: Pick<NotetakerAdHocBookingWithLatestSessionRecord, "choice" | "latestSessionStatus">
): boolean {
  const { choice, latestSessionStatus } = meeting;
  const hasLiveSession =
    latestSessionStatus !== null && NOTETAKER_LIVE_SESSION_STATUSES.includes(latestSessionStatus);
  if (hasLiveSession) return true;
  if (choice?.enabled && choice.pendingDispatch) return true;
  return latestSessionStatus === null && choice?.enabled !== false;
}
