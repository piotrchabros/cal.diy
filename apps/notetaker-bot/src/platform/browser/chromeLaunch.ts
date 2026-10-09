import type { MeetingBrowserOptions } from "./MeetingPage";

export type ChromeLaunchOptions = {
  channel: string;
  headless: boolean;
  args: string[];
  handleSIGINT: false;
  handleSIGTERM: false;
};

// Playwright's default handlers close the browser on SIGTERM/SIGINT, which is the same signal that makes the
// runner start its leave click, so the browser would die before the click lands.
export function buildChromeLaunchOptions(
  options: Pick<MeetingBrowserOptions, "channel" | "headless">
): ChromeLaunchOptions {
  return {
    channel: options.channel,
    headless: options.headless,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    handleSIGINT: false,
    handleSIGTERM: false,
  };
}

// Playwright messages embed call logs that can contain the meeting URL or typed values, so only the error class
// name leaves this module; it is also set as `name` so logged errorName values stay diagnosable.
export function sanitizeBrowserError(operation: string, error: unknown): Error {
  const className = error instanceof Error ? error.name : "unknown";
  const sanitized = new Error(`Meeting browser ${operation} failed (${className})`);
  sanitized.name = className;
  return sanitized;
}
