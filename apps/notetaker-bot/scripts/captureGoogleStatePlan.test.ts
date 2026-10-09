// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getRunnerConfig } from "../src/config";
import {
  type AbortCause,
  abortMessage,
  CAPTURE_GOOGLE_STATE_USAGE,
  capturePreflightRefusal,
  decideSignedIn,
  describeLaunchFailure,
  encodeStorageState,
  exitCodeForAbort,
  hasGoogleSessionCookie,
  isCapturedStorageState,
  outFileInstruction,
  outFileWriteFailureMessage,
  PASTE_INSTRUCTION,
  parseCaptureGoogleStateArgs,
  resolveChromeChannel,
  SIGN_IN_PROMPT_MESSAGE,
  type SignedInPageFacts,
  type SignedInRefusalReason,
  serializeStorageState,
  sessionCheckFailureMessage,
  signedInRefusalMessage,
  stdoutValueLine,
} from "./captureGoogleStatePlan";

const SCRIPTS_DIRECTORY = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

const readScript = (name: string): string => readFileSync(path.join(SCRIPTS_DIRECTORY, name), "utf8");

const goodFacts = (overrides: Partial<SignedInPageFacts> = {}): SignedInPageFacts => ({
  hasSessionCookie: true,
  accountPageUrl: "https://myaccount.google.com/?hl=en",
  meetHomeUrl: "https://meet.google.com/landing",
  meetSignedInMarkerVisible: true,
  meetSignInPromptVisible: false,
  ...overrides,
});

const parseFailure = (argv: string[]): string => {
  try {
    parseCaptureGoogleStateArgs(argv);
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "";
};

describe("parseCaptureGoogleStateArgs", () => {
  it("returns no out file and no help for no arguments", () => {
    expect(parseCaptureGoogleStateArgs([])).toEqual({ outFile: null, help: false });
  });

  it("keeps an absolute --out path as given", () => {
    expect(parseCaptureGoogleStateArgs(["--out", "/tmp/x.json"])).toEqual({
      outFile: "/tmp/x.json",
      help: false,
    });
  });

  it("accepts the --out=value form", () => {
    expect(parseCaptureGoogleStateArgs(["--out=/tmp/x.json"]).outFile).toBe("/tmp/x.json");
  });

  it.each([
    ["--help alone", ["--help"]],
    ["--help with an invalid --out", ["--help", "--out", "rel"]],
  ])("returns help and no out file for %s", (_name, argv) => {
    expect(parseCaptureGoogleStateArgs(argv)).toEqual({ outFile: null, help: true });
  });

  it.each([
    ["--out without a value", ["--out"]],
    ["an empty --out", ["--out", ""]],
    ["a relative --out", ["--out", "state.json"]],
    ["an unknown flag", ["--nope"]],
    ["a positional argument", ["positional"]],
  ])("throws for %s", (_name, argv) => {
    expect(() => parseCaptureGoogleStateArgs(argv)).toThrow(Error);
  });

  it("explains an empty --out", () => {
    expect(parseFailure(["--out", ""])).toBe("--out needs a file path");
  });

  it("explains a relative --out", () => {
    expect(parseFailure(["--out", "state.json"])).toBe("--out must be an absolute path");
  });
});

describe("resolveChromeChannel", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["blanks", "  "],
  ])("falls back to chrome for %s", (_name, value) => {
    expect(resolveChromeChannel(value)).toBe("chrome");
  });

  it("trims a configured channel", () => {
    expect(resolveChromeChannel(" msedge ")).toBe("msedge");
  });
});

describe("capturePreflightRefusal", () => {
  it("refuses without a terminal, even when the out file also exists", () => {
    const message = capturePreflightRefusal(
      { outFile: "/tmp/x.json", help: false },
      { stdinIsTty: false, outFileExists: true }
    );

    expect(message).toContain("needs a terminal");
  });

  it("refuses to overwrite an existing out file", () => {
    const message = capturePreflightRefusal(
      { outFile: "/tmp/x.json", help: false },
      { stdinIsTty: true, outFileExists: true }
    );

    expect(message).toContain("/tmp/x.json");
    expect(message).toContain("will not be overwritten");
  });

  it("ignores the out file fact when there is no --out", () => {
    expect(
      capturePreflightRefusal({ outFile: null, help: false }, { stdinIsTty: true, outFileExists: true })
    ).toBeNull();
  });

  it("allows a terminal and a free out file", () => {
    expect(
      capturePreflightRefusal(
        { outFile: "/tmp/x.json", help: false },
        { stdinIsTty: true, outFileExists: false }
      )
    ).toBeNull();
  });
});

describe("hasGoogleSessionCookie", () => {
  it.each(["SID", "__Secure-1PSID", "__Secure-3PSID"])("accepts %s on .google.com", (name) => {
    expect(hasGoogleSessionCookie([{ name, domain: ".google.com" }])).toBe(true);
  });

  it("accepts a subdomain of google.com", () => {
    expect(hasGoogleSessionCookie([{ name: "SID", domain: "accounts.google.com" }])).toBe(true);
  });

  it.each([".notgoogle.com", "google.com.evil.test"])("rejects SID on %s", (domain) => {
    expect(hasGoogleSessionCookie([{ name: "SID", domain }])).toBe(false);
  });

  it("rejects a cookie with another name", () => {
    expect(hasGoogleSessionCookie([{ name: "NID", domain: ".google.com" }])).toBe(false);
  });

  it("rejects an empty list", () => {
    expect(hasGoogleSessionCookie([])).toBe(false);
  });
});

describe("decideSignedIn", () => {
  it("accepts a session with every fact good", () => {
    expect(decideSignedIn(goodFacts())).toEqual({ signedIn: true, meetMarkerSeen: true });
  });

  it("accepts a session where Meet shows neither the marker nor a sign-in link", () => {
    expect(
      decideSignedIn(goodFacts({ meetSignedInMarkerVisible: false, meetSignInPromptVisible: false }))
    ).toEqual({ signedIn: true, meetMarkerSeen: false });
  });

  it("lets the signed-in marker outweigh a sign-in link", () => {
    expect(
      decideSignedIn(goodFacts({ meetSignedInMarkerVisible: true, meetSignInPromptVisible: true }))
    ).toEqual({ signedIn: true, meetMarkerSeen: true });
  });

  it("refuses without a session cookie", () => {
    expect(decideSignedIn(goodFacts({ hasSessionCookie: false }))).toEqual({
      signedIn: false,
      reason: "no_session_cookie",
    });
  });

  it("refuses when the account page redirected to sign-in", () => {
    expect(
      decideSignedIn(goodFacts({ accountPageUrl: "https://accounts.google.com/ServiceLogin?continue=x" }))
    ).toEqual({ signedIn: false, reason: "account_page_redirected" });
  });

  it("refuses an account page that is not https", () => {
    expect(decideSignedIn(goodFacts({ accountPageUrl: "http://myaccount.google.com/" }))).toEqual({
      signedIn: false,
      reason: "account_page_redirected",
    });
  });

  it("treats an unparsable account page URL as a redirect", () => {
    expect(decideSignedIn(goodFacts({ accountPageUrl: "not a url" }))).toEqual({
      signedIn: false,
      reason: "account_page_redirected",
    });
  });

  it("refuses when Meet redirected away from meet.google.com", () => {
    expect(decideSignedIn(goodFacts({ meetHomeUrl: "https://workspace.google.com/products/meet/" }))).toEqual(
      { signedIn: false, reason: "meet_redirected" }
    );
  });

  it("refuses when Meet shows a sign-in link and no signed-in marker", () => {
    expect(
      decideSignedIn(goodFacts({ meetSignedInMarkerVisible: false, meetSignInPromptVisible: true }))
    ).toEqual({ signedIn: false, reason: "meet_shows_sign_in" });
  });

  it("reports the first failing rule when several fail", () => {
    const allBad = goodFacts({
      hasSessionCookie: false,
      accountPageUrl: "https://accounts.google.com/",
      meetHomeUrl: "https://workspace.google.com/",
      meetSignedInMarkerVisible: false,
      meetSignInPromptVisible: true,
    });

    expect(decideSignedIn(allBad)).toEqual({ signedIn: false, reason: "no_session_cookie" });
    expect(decideSignedIn({ ...allBad, hasSessionCookie: true })).toEqual({
      signedIn: false,
      reason: "account_page_redirected",
    });
    expect(
      decideSignedIn({ ...allBad, hasSessionCookie: true, accountPageUrl: goodFacts().accountPageUrl })
    ).toEqual({ signedIn: false, reason: "meet_redirected" });
    expect(
      decideSignedIn({
        ...allBad,
        hasSessionCookie: true,
        accountPageUrl: goodFacts().accountPageUrl,
        meetHomeUrl: goodFacts().meetHomeUrl,
      })
    ).toEqual({ signedIn: false, reason: "meet_shows_sign_in" });
  });
});

describe("signedInRefusalMessage", () => {
  const reasons: SignedInRefusalReason[] = [
    "no_session_cookie",
    "account_page_redirected",
    "meet_redirected",
    "meet_shows_sign_in",
  ];

  it("starts and ends every message the same way", () => {
    for (const reason of reasons) {
      const message = signedInRefusalMessage(reason);
      expect(message.startsWith("capture-google-state: could not confirm")).toBe(true);
      expect(message.endsWith("Nothing was written.\n")).toBe(true);
    }
  });

  it("gives each reason its own message", () => {
    expect(new Set(reasons.map(signedInRefusalMessage)).size).toBe(reasons.length);
  });
});

describe("storage state encoding", () => {
  // The long run of "?" guarantees "/" in the base64 whatever the alignment, so the standard
  // alphabet (not base64url) is really exercised, and the non-ASCII text exercises UTF-8.
  const state = {
    cookies: [{ name: "SID", value: `${"?".repeat(60)}>>>~~~ zażółć 日本語`, domain: ".google.com" }],
    origins: [{ origin: "https://meet.google.com", localStorage: [] }],
  };

  it("produces one line of standard base64 with padding", () => {
    const encoded = encodeStorageState(state);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded).toMatch(/[+/]/);
    expect(encoded).not.toContain("\n");
  });

  it("is accepted by the bot's own configuration and decodes to the same state", () => {
    const encoded = encodeStorageState(state);

    const config = getRunnerConfig({
      NOTETAKER_BOT_SECRET: "test-secret-not-real",
      NOTETAKER_BOT_ADAPTER: "fake",
      NOTETAKER_GOOGLE_JOIN_MODE: "account",
      NOTETAKER_GOOGLE_STORAGE_STATE_B64: encoded,
    });

    expect(config.google.storageState).toEqual(state);
  });

  it("recognises only objects with cookies and origins arrays", () => {
    expect(isCapturedStorageState(state)).toBe(true);
    expect(isCapturedStorageState({ cookies: [], origins: [] })).toBe(true);
    expect(isCapturedStorageState({})).toBe(false);
    expect(isCapturedStorageState({ cookies: [], origins: "x" })).toBe(false);
    expect(isCapturedStorageState({ cookies: {}, origins: [] })).toBe(false);
    expect(isCapturedStorageState(null)).toBe(false);
    expect(isCapturedStorageState("text")).toBe(false);
  });

  it("refuses to encode an object without the arrays", () => {
    const notAState = JSON.parse("{}");

    expect(() => encodeStorageState(notAState)).toThrow(
      "storage state must be an object with cookies and origins arrays"
    );
  });

  it("serializes to JSON that parses back, ending in a newline", () => {
    const serialized = serializeStorageState(state);

    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(state);
  });

  it("puts the value on a line of its own", () => {
    expect(stdoutValueLine("abc")).toBe("abc\n");
  });
});

describe("messages", () => {
  it("quotes the out file path for the shell in the --out instruction", () => {
    const instruction = outFileInstruction("/tmp/o'k.json");

    expect(instruction).toContain("base64 -w0 '/tmp/o'\\''k.json'");
    expect(instruction).toContain("mode 0600");
    expect(instruction).toContain("NOTETAKER_GOOGLE_STORAGE_STATE_B64");
  });

  it.each([
    ["interrupted", 130],
    ["browser_closed", 1],
    ["stdin_closed", 1],
  ] as [
    AbortCause,
    number,
  ][])("gives %s exit code %s and a message that says nothing was written", (cause, code) => {
    expect(exitCodeForAbort(cause)).toBe(code);
    expect(abortMessage(cause).endsWith("Nothing was written.\n")).toBe(true);
  });

  it("describes a missing Chrome without echoing the raw error", () => {
    const errorMessage = "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome";
    const message = describeLaunchFailure({ channel: "chrome", errorName: "Error", errorMessage });

    expect(message).toContain('Google Chrome was not found for channel "chrome"');
    expect(message).toContain("NOTETAKER_CHROME_CHANNEL");
    expect(message).not.toContain(errorMessage);
    expect(message.endsWith("Nothing was written.\n")).toBe(true);
  });

  it("describes a missing display without echoing the raw error", () => {
    const errorMessage = "Missing X server or $DISPLAY";
    const message = describeLaunchFailure({ channel: "chrome", errorName: "Error", errorMessage });

    expect(message).toContain("Chrome needs a display");
    expect(message).not.toContain(errorMessage);
    expect(message.endsWith("Nothing was written.\n")).toBe(true);
  });

  it("falls back to naming the error class for any other launch failure", () => {
    const errorMessage = "boom";
    const message = describeLaunchFailure({ channel: "msedge", errorName: "TimeoutError", errorMessage });

    expect(message).toContain('channel "msedge"');
    expect(message).toContain("TimeoutError");
    expect(message).not.toContain(errorMessage);
    expect(message.endsWith("Nothing was written.\n")).toBe(true);
  });

  it("names only the error class when the session check fails", () => {
    expect(sessionCheckFailureMessage("TimeoutError")).toBe(
      "capture-google-state: could not check the session (TimeoutError). Nothing was written.\n"
    );
  });

  it("reports a failed out file write with its code, or unknown", () => {
    expect(outFileWriteFailureMessage("/tmp/x.json", "EEXIST")).toBe(
      "capture-google-state: could not write /tmp/x.json (EEXIST). The session was not printed either.\n"
    );
    expect(outFileWriteFailureMessage("/tmp/x.json", null)).toContain("(unknown)");
  });

  it("names the variable in the paste instruction and Enter in the sign-in prompt", () => {
    expect(PASTE_INSTRUCTION).toContain("NOTETAKER_GOOGLE_STORAGE_STATE_B64");
    expect(SIGN_IN_PROMPT_MESSAGE).toContain("Enter");
  });

  it("documents the options, the variables and the file mode in the usage text", () => {
    expect(
      CAPTURE_GOOGLE_STATE_USAGE.startsWith(
        "Usage: yarn workspace @calcom/notetaker-bot capture-google-state [--out <file>]"
      )
    ).toBe(true);
    expect(CAPTURE_GOOGLE_STATE_USAGE.endsWith("\n")).toBe(true);
    for (const fragment of [
      "--out <file>",
      "--help",
      "NOTETAKER_GOOGLE_STORAGE_STATE_B64",
      "NOTETAKER_CHROME_CHANNEL",
      "0600",
      "absolute",
      "only thing written to standard output",
    ]) {
      expect(CAPTURE_GOOGLE_STATE_USAGE).toContain(fragment);
    }
  });
});

// The script itself cannot run in a test, so its safety properties are checked as text.
describe("textual guards", () => {
  it("keeps Playwright out of the pure module", () => {
    expect(readScript("captureGoogleStatePlan.ts")).not.toMatch(/["'`]playwright(?:-core)?["'`]/);
  });

  it("marks the script as unverified", () => {
    expect(readScript("capture-google-storage-state.ts")).toContain("UNVERIFIED AGAINST THE REAL SERVICE");
  });

  it.each([
    "recordVideo",
    "recordHar",
    "tracing.start",
    ".screenshot(",
    ".pdf(",
  ])("keeps %s out of the script", (needle) => {
    expect(readScript("capture-google-storage-state.ts")).not.toContain(needle);
  });

  it("reads the storage state into memory instead of letting Playwright write a file", () => {
    const source = readScript("capture-google-storage-state.ts");

    expect(source).toContain("storageState()");
    expect(source).not.toContain("storageState({");
  });

  it("writes nothing through console", () => {
    expect(readScript("capture-google-storage-state.ts")).not.toContain("console.");
  });
});
