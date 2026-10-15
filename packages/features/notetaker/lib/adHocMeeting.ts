import { classifyMeetingUrl } from "./eligibility";

const GOOGLE_MEET_HOST = "meet.google.com";
const MEET_CODE_PATH = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export const NOTETAKER_AD_HOC_KEY = "notetakerAdHoc";
export const NOTETAKER_AD_HOC_SHARING_TEAM_KEY = "notetakerSharingTeamId";

export type AdHocMeetingUrlResult =
  | { ok: true; platform: "GOOGLE_MEET"; meetingUrl: string }
  | { ok: false; reason: "INVALID_MEETING_LINK" | "UNSUPPORTED_PLATFORM" };

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// The bot joins whatever URL we store, so only an exact Meet host with a real meeting code is accepted;
// userinfo and ports are rejected because they can make a look-alike URL resolve elsewhere.
export function parseAdHocMeetingUrl(raw: string): AdHocMeetingUrlResult {
  const invalid = { ok: false, reason: "INVALID_MEETING_LINK" } as const;
  const parsed = parseUrl(raw.trim());
  if (!parsed) return invalid;
  if (parsed.protocol !== "https:") return invalid;
  if (parsed.username || parsed.password || parsed.port) return invalid;

  if (parsed.hostname !== GOOGLE_MEET_HOST) {
    return classifyMeetingUrl(parsed.href) ? { ok: false, reason: "UNSUPPORTED_PLATFORM" } : invalid;
  }

  const code = MEET_CODE_PATH.exec(parsed.pathname)?.[1];
  if (!code) return invalid;
  return {
    ok: true,
    platform: "GOOGLE_MEET",
    meetingUrl: `https://${GOOGLE_MEET_HOST}/${code.toLowerCase()}`,
  };
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
