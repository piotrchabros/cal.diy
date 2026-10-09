import { Buffer } from "node:buffer";
import path from "node:path";
import { parseArgs } from "node:util";

export const STORAGE_STATE_VARIABLE = "NOTETAKER_GOOGLE_STORAGE_STATE_B64";
export const DEFAULT_CHROME_CHANNEL = "chrome";
export const GOOGLE_ACCOUNT_PAGE_URL = "https://myaccount.google.com/?hl=en";
export const GOOGLE_MEET_HOME_URL = "https://meet.google.com/";
export const MEET_SIGN_IN_PROMPT_SELECTOR = 'a[href*="accounts.google.com"]:has-text("Sign in"):visible';
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_INTERRUPTED = 130;

export const CAPTURE_GOOGLE_STATE_USAGE = `Usage: yarn workspace @calcom/notetaker-bot capture-google-state [--out <file>]

Opens Chrome so a person can sign in to the bot's Google account, then prints the session as the value
for ${STORAGE_STATE_VARIABLE}.

Flags:
  --out <file>   Write the session as JSON to this file instead of printing the encoded value.
                 The path must be absolute and the file must not exist yet; it is created with mode 0600.
  --help         Show this help

Output:
  Without --out the encoded value is the only thing written to standard output; everything else goes to
  standard error, so the value can be piped to a clipboard tool.

Environment:
  NOTETAKER_CHROME_CHANNEL   Chrome channel to launch (default: chrome)

The output is a credential. Treat it like a password.
`;

export const SIGN_IN_PROMPT_MESSAGE =
  "capture-google-state: sign in to the bot's Google account in the Chrome window, finish any two-step challenge, then come back here and press Enter. Press Ctrl+C to give up.\n";

export const PASTE_INSTRUCTION =
  "capture-google-state: the line on standard output is the value for NOTETAKER_GOOGLE_STORAGE_STATE_B64 in apps/notetaker-bot/.env. It is a credential: treat it like a password and clear it from your terminal scrollback.\n";

export type CaptureGoogleStateOptions = { outFile: string | null; help: boolean };

export function parseCaptureGoogleStateArgs(argv: string[]): CaptureGoogleStateOptions {
  const values = readFlags(argv);
  if (values.help === true) return { outFile: null, help: true };

  const out = values.out;
  if (out === undefined) return { outFile: null, help: false };
  if (out === "") throw new Error("--out needs a file path");
  // `yarn workspace ... <script>` runs with the workspace as its working directory, so a relative
  // path would put the credential inside the repository.
  if (!path.isAbsolute(out)) throw new Error("--out must be an absolute path");
  return { outFile: out, help: false };
}

function readFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        out: { type: "string" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export function resolveChromeChannel(envValue: string | undefined): string {
  const trimmed = envValue?.trim() ?? "";
  return trimmed === "" ? DEFAULT_CHROME_CHANNEL : trimmed;
}

export type CapturePreflightFacts = { stdinIsTty: boolean; outFileExists: boolean };

export function capturePreflightRefusal(
  options: CaptureGoogleStateOptions,
  facts: CapturePreflightFacts
): string | null {
  if (!facts.stdinIsTty) {
    return "capture-google-state: this script needs a terminal, because it waits for you to press Enter after signing in. Nothing was written.\n";
  }
  if (options.outFile !== null && facts.outFileExists) {
    return `capture-google-state: ${options.outFile} already exists and will not be overwritten. Delete it or choose another path. Nothing was written.\n`;
  }
  return null;
}

export type StoredCookieFacts = { name: string; domain: string };

const SESSION_COOKIE_NAMES: readonly string[] = ["SID", "__Secure-1PSID", "__Secure-3PSID"];

function isGoogleDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return normalized === "google.com" || normalized.endsWith(".google.com");
}

export function hasGoogleSessionCookie(cookies: readonly StoredCookieFacts[]): boolean {
  return cookies.some(
    (cookie) => SESSION_COOKIE_NAMES.includes(cookie.name) && isGoogleDomain(cookie.domain)
  );
}

export type SignedInPageFacts = {
  hasSessionCookie: boolean;
  accountPageUrl: string;
  meetHomeUrl: string;
  meetSignedInMarkerVisible: boolean;
  meetSignInPromptVisible: boolean;
};

export type SignedInRefusalReason =
  | "no_session_cookie"
  | "account_page_redirected"
  | "meet_redirected"
  | "meet_shows_sign_in";

export type SignedInVerdict =
  | { signedIn: true; meetMarkerSeen: boolean }
  | { signedIn: false; reason: SignedInRefusalReason };

function isHttpsUrlOnHost(value: string, hostname: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.hostname === hostname;
}

// The hostnames and cookie names used here are from memory, not checked against Google; they are
// covered by this script's row in docs/verification-status.md. The Meet marker only corroborates,
// because the bot's own selector for it is an unverified guess that must not block a good session.
export function decideSignedIn(facts: SignedInPageFacts): SignedInVerdict {
  if (!facts.hasSessionCookie) return { signedIn: false, reason: "no_session_cookie" };
  if (!isHttpsUrlOnHost(facts.accountPageUrl, "myaccount.google.com")) {
    return { signedIn: false, reason: "account_page_redirected" };
  }
  if (!isHttpsUrlOnHost(facts.meetHomeUrl, "meet.google.com")) {
    return { signedIn: false, reason: "meet_redirected" };
  }
  if (facts.meetSignInPromptVisible && !facts.meetSignedInMarkerVisible) {
    return { signedIn: false, reason: "meet_shows_sign_in" };
  }
  return { signedIn: true, meetMarkerSeen: facts.meetSignedInMarkerVisible };
}

const REFUSAL_DETAILS: Record<SignedInRefusalReason, string> = {
  no_session_cookie: "the browser holds no Google session cookie.",
  account_page_redirected:
    "the Google account page redirected away, which is what a signed-out browser does.",
  meet_redirected: "Google Meet redirected away from meet.google.com.",
  meet_shows_sign_in: "Google Meet shows a sign-in link.",
};

export function signedInRefusalMessage(reason: SignedInRefusalReason): string {
  return `capture-google-state: could not confirm that the session is signed in: ${REFUSAL_DETAILS[reason]} Nothing was written.\n`;
}

export type CapturedStorageState = { cookies: readonly unknown[]; origins: readonly unknown[] };

export function isCapturedStorageState(value: unknown): value is CapturedStorageState {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(Reflect.get(value, "cookies")) && Array.isArray(Reflect.get(value, "origins"));
}

// Standard base64 with padding on one line: the bot's config only accepts that alphabet, not base64url.
export function encodeStorageState(state: CapturedStorageState): string {
  if (!isCapturedStorageState(state)) {
    throw new Error("storage state must be an object with cookies and origins arrays");
  }
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function serializeStorageState(state: CapturedStorageState): string {
  return `${JSON.stringify(state)}\n`;
}

export function stdoutValueLine(encoded: string): string {
  return `${encoded}\n`;
}

export function outFileInstruction(outFile: string): string {
  const quoted = `'${outFile.replace(/'/g, "'\\''")}'`;
  return [
    `capture-google-state: wrote the session to ${outFile} (mode 0600). It is a credential.\n`,
    `Encode it on one line with: base64 -w0 ${quoted}   (macOS: base64 -i ${quoted})\n`,
    "Paste the output into NOTETAKER_GOOGLE_STORAGE_STATE_B64 in apps/notetaker-bot/.env, then delete the file.\n",
  ].join("");
}

export type AbortCause = "interrupted" | "browser_closed" | "stdin_closed";

export function abortMessage(cause: AbortCause): string {
  switch (cause) {
    case "interrupted":
      return "capture-google-state: interrupted. The browser was closed. Nothing was written.\n";
    case "browser_closed":
      return "capture-google-state: the Chrome window was closed before you pressed Enter. Nothing was written.\n";
    case "stdin_closed":
      return "capture-google-state: standard input ended before you pressed Enter. Nothing was written.\n";
  }
}

export function exitCodeForAbort(cause: AbortCause): number {
  return cause === "interrupted" ? EXIT_INTERRUPTED : EXIT_FAILED;
}

// Both patterns are from memory of Playwright's launch errors; the fallback names both likely
// causes so a changed wording still gives the operator something true. The raw message is never
// echoed because it can contain local paths.
export function describeLaunchFailure(input: {
  channel: string;
  errorName: string;
  errorMessage: string;
}): string {
  const { channel, errorName, errorMessage } = input;
  let middle: string;
  if (/is not found at|Executable doesn't exist|playwright install/i.test(errorMessage)) {
    middle = `Google Chrome was not found for channel "${channel}". Install Google Chrome on this machine, or set NOTETAKER_CHROME_CHANNEL to the channel the bot uses.`;
  } else if (/Missing X server|\$DISPLAY|headed browser/i.test(errorMessage)) {
    middle = "Chrome needs a display. Run this on a machine with a desktop session.";
  } else {
    middle = `Chrome could not be started through channel "${channel}" (${errorName}). This script needs Google Chrome installed and a display.`;
  }
  return `capture-google-state: ${middle} Nothing was written.\n`;
}

export function sessionCheckFailureMessage(errorName: string): string {
  return `capture-google-state: could not check the session (${errorName}). Nothing was written.\n`;
}

export function outFileWriteFailureMessage(outFile: string, errorCode: string | null): string {
  return `capture-google-state: could not write ${outFile} (${errorCode ?? "unknown"}). The session was not printed either.\n`;
}
