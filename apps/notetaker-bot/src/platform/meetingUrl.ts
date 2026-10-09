import type { PlatformName } from "./PlatformAdapter";

// These mirror the hosts the app classifies and are repeated here because the bot cannot import the app's packages.
const JOINABLE_HOSTS: Record<PlatformName, readonly string[]> = {
  GOOGLE_MEET: ["meet.google.com"],
  MICROSOFT_TEAMS: ["teams.microsoft.com", "teams.live.com"],
};

export function isJoinableMeetingUrl(platform: PlatformName, meetingUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(meetingUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // The app classifies by hostname, so a port must not make the bot refuse a link the app accepted.
  if (!JOINABLE_HOSTS[platform].includes(url.hostname)) return false;

  return url.pathname.length > 1;
}
