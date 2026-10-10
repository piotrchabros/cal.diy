// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getRunnerConfig } from "../src/config";
import {
  configFailureMessage,
  EXIT_FAILED,
  EXIT_INTERRUPTED,
  EXIT_OK,
  exitCodeForOutcome,
  leakRefusalMessage,
  MEET_PROBE_USAGE,
  type MeetProbePreflightFacts,
  meetProbePreflightRefusal,
  outcomeMessage,
  outFileOpenFailureMessage,
  outFileWriteFailureMessage,
  parseMeetProbeArgs,
  probeConfigEnv,
  reportWrittenMessage,
  resolveCredentialRoute,
  UNEXPECTED_ERROR_MESSAGE,
  usageErrorOutput,
} from "./meetProbePlan";
import type { MeetProbeOptions, ProbeOutcome } from "./meetProbeTypes";

const SCRIPTS_DIRECTORY = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
const OUT = "/tmp/probe.json";

const parseFailure = (argv: string[]): string => {
  try {
    parseMeetProbeArgs(argv);
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "";
};

const baseArgs = (extra: string[] = []): string[] => [MEETING_URL, "--out", OUT, ...extra];

const options = (overrides: Partial<MeetProbeOptions> = {}): MeetProbeOptions => ({
  ...parseMeetProbeArgs(baseArgs()),
  ...overrides,
});

const goodFacts = (overrides: Partial<MeetProbePreflightFacts> = {}): MeetProbePreflightFacts => ({
  outFileExists: false,
  outDirectoryExists: true,
  outDirectoryWritable: true,
  joinMode: "guest",
  hasStorageState: false,
  hasAccountEmail: false,
  hasAccountPassword: false,
  ...overrides,
});

describe("parseMeetProbeArgs", () => {
  it("applies the defaults", () => {
    expect(parseMeetProbeArgs(baseArgs())).toEqual({
      meetingUrl: MEETING_URL,
      outFile: OUT,
      durationSeconds: 60,
      intervalMs: 1000,
      admitTimeoutSeconds: 300,
      redactNames: true,
      postNotice: true,
      help: false,
    });
  });

  it("accepts the URL after the flags and the --flag=value form", () => {
    const parsed = parseMeetProbeArgs([`--out=${OUT}`, "--duration=30", MEETING_URL]);

    expect(parsed.meetingUrl).toBe(MEETING_URL);
    expect(parsed.outFile).toBe(OUT);
    expect(parsed.durationSeconds).toBe(30);
  });

  it("reads every numeric flag", () => {
    const parsed = parseMeetProbeArgs(
      baseArgs(["--duration", "120", "--interval-ms", "500", "--admit-timeout", "45"])
    );

    expect(parsed.durationSeconds).toBe(120);
    expect(parsed.intervalMs).toBe(500);
    expect(parsed.admitTimeoutSeconds).toBe(45);
  });

  it("keeps redaction on for --redact-names and turns it off for --no-redact-names", () => {
    expect(parseMeetProbeArgs(baseArgs(["--redact-names"])).redactNames).toBe(true);
    expect(parseMeetProbeArgs(baseArgs(["--no-redact-names"])).redactNames).toBe(false);
  });

  it("refuses both redaction flags together, in either order", () => {
    const message = "--redact-names and --no-redact-names cannot be used together";

    expect(parseFailure(baseArgs(["--redact-names", "--no-redact-names"]))).toBe(message);
    expect(parseFailure(baseArgs(["--no-redact-names", "--redact-names"]))).toBe(message);
  });

  it("turns the notice off with --no-notice", () => {
    expect(parseMeetProbeArgs(baseArgs(["--no-notice"])).postNotice).toBe(false);
  });

  it.each([
    ["--help alone", ["--help"]],
    ["--help with an invalid URL", ["--help", "https://example.com/x"]],
    ["--help with a relative --out", ["--help", "--out", "rel"]],
  ])("returns help for %s", (_name, argv) => {
    const parsed = parseMeetProbeArgs(argv);

    expect(parsed.help).toBe(true);
    expect(parsed.meetingUrl).toBe("");
  });

  it("explains each argument error specifically", () => {
    expect(parseFailure(["--out", OUT])).toBe("the meeting URL is missing");
    expect(parseFailure([MEETING_URL, `${MEETING_URL}2`, "--out", OUT])).toBe(
      "only one meeting URL is accepted"
    );
    expect(parseFailure(["https://example.com/abc", "--out", OUT])).toBe(
      "the meeting URL must be a Google Meet link on meet.google.com"
    );
    expect(parseFailure(["not a url", "--out", OUT])).toBe(
      "the meeting URL must be a Google Meet link on meet.google.com"
    );
    expect(parseFailure([MEETING_URL])).toBe("--out is required");
    expect(parseFailure([MEETING_URL, "--out", ""])).toBe("--out needs a file path");
    expect(parseFailure([MEETING_URL, "--out", "probe.json"])).toBe("--out must be an absolute path");
  });

  it("refuses a bare Meet host without a meeting code", () => {
    expect(parseFailure(["https://meet.google.com/", "--out", OUT])).toContain("Google Meet link");
  });

  it("explains an unknown flag and a missing value", () => {
    expect(parseFailure(baseArgs(["--nope"]))).toBe("unknown option --nope");
    expect(parseFailure([MEETING_URL, "--out"])).toBe("--out needs a value");
    expect(parseFailure(baseArgs(["--duration"]))).toBe("--duration needs a value");
  });

  it.each([
    ["--duration", "10", "9", "600", "601", "10 to 600"],
    ["--interval-ms", "250", "249", "5000", "5001", "250 to 5000"],
    ["--admit-timeout", "10", "9", "1800", "1801", "10 to 1800"],
  ])("accepts the boundaries of %s and refuses just outside", (flag, low, belowLow, high, aboveHigh, range) => {
    expect(() => parseMeetProbeArgs(baseArgs([flag, low]))).not.toThrow();
    expect(() => parseMeetProbeArgs(baseArgs([flag, high]))).not.toThrow();
    for (const bad of [belowLow, aboveHigh, "0", "-5", "abc", "12.5", "1e3", "", " 30", "99999999999"]) {
      expect(parseFailure(baseArgs([`${flag}=${bad}`]))).toBe(`${flag} must be a whole number from ${range}`);
    }
  });

  it("never echoes the meeting URL in an error", () => {
    const secretUrl = "https://meet.google.com/zzz-secret-code";
    const cases: string[][] = [
      [secretUrl],
      [secretUrl, "--out", "relative.json"],
      [secretUrl, "--out", ""],
      [secretUrl, "--out", OUT, "--duration", secretUrl],
      [secretUrl, "--out", OUT, "--interval-ms", "1"],
      [secretUrl, "--out", OUT, "--redact-names", "--no-redact-names"],
      [secretUrl, secretUrl, "--out", OUT],
      [secretUrl, "--out", OUT, `--oops=${secretUrl}`],
      [secretUrl, "--out", OUT, "-z", secretUrl],
      [secretUrl, "--out"],
      [`${secretUrl}.evil.test`.replace("meet.google.com", "evil.test"), "--out", OUT],
      ["--out", OUT, `--duration=${secretUrl}`],
    ];

    for (const argv of cases) {
      const message = parseFailure(argv);
      expect(message).not.toBe("");
      expect(message).not.toContain("zzz-secret-code");
      expect(usageErrorOutput(message)).not.toContain("zzz-secret-code");
    }
  });
});

describe("probeConfigEnv", () => {
  const accountState = Buffer.from(JSON.stringify({ cookies: [], origins: [] }), "utf8").toString("base64");

  it("is accepted by the bot's own configuration with a minimal account-mode environment", () => {
    const env = {
      NOTETAKER_GOOGLE_JOIN_MODE: "account",
      NOTETAKER_GOOGLE_STORAGE_STATE_B64: accountState,
      NOTETAKER_CHROME_CHANNEL: "msedge",
      NOTETAKER_CHROME_HEADLESS: "true",
    };

    const config = getRunnerConfig(probeConfigEnv(env));

    expect(config.adapterMode).toBe("fake");
    expect(config.soniox).toBeNull();
    expect(config.google.joinMode).toBe("account");
    expect(config.google.storageState).toEqual({ cookies: [], origins: [] });
    expect(config.chrome).toEqual({ channel: "msedge", headless: true });
  });

  it("is accepted with an empty environment and joins as a guest in the default Chrome", () => {
    const config = getRunnerConfig(probeConfigEnv({}));

    expect(config.adapterMode).toBe("fake");
    expect(config.google).toEqual({ joinMode: "guest", storageState: null, email: null, password: null });
    expect(config.chrome).toEqual({ channel: "chrome", headless: false });
  });

  it("passes the account credentials through untouched", () => {
    const config = getRunnerConfig(
      probeConfigEnv({
        NOTETAKER_GOOGLE_JOIN_MODE: "account",
        NOTETAKER_GOOGLE_ACCOUNT_EMAIL: "bot@example.test",
        NOTETAKER_GOOGLE_ACCOUNT_PASSWORD: "pw-not-real",
      })
    );

    expect(config.google.email).toBe("bot@example.test");
    expect(config.google.password).toBe("pw-not-real");
  });

  it("still refuses account mode without any credential, naming only variables", () => {
    expect(() => getRunnerConfig(probeConfigEnv({ NOTETAKER_GOOGLE_JOIN_MODE: "account" }))).toThrow(
      "NOTETAKER_GOOGLE_STORAGE_STATE_B64"
    );
  });

  it("replaces the real adapter, secret and speech-to-text settings and drops production mode", () => {
    const env = {
      NOTETAKER_BOT_ADAPTER: "real",
      NOTETAKER_BOT_SECRET: "the-real-secret",
      SONIOX_API_KEY: "key-not-real",
      SONIOX_WS_URL: "not a url",
      SONIOX_MODEL: "model",
      NOTETAKER_FAKE_MEETING_SECONDS: "abc",
      NODE_ENV: "production",
    };

    const result = probeConfigEnv(env);

    expect(result.NOTETAKER_BOT_ADAPTER).toBe("fake");
    expect(result.NOTETAKER_BOT_SECRET).not.toBe("the-real-secret");
    expect(result.NOTETAKER_BOT_SECRET).toBeTruthy();
    for (const key of [
      "SONIOX_API_KEY",
      "SONIOX_WS_URL",
      "SONIOX_MODEL",
      "NOTETAKER_FAKE_MEETING_SECONDS",
      "NODE_ENV",
    ]) {
      expect(key in result).toBe(false);
    }
    expect(() => getRunnerConfig(result)).not.toThrow();
  });

  it("passes every other variable through and does not mutate its argument", () => {
    const env = {
      NOTETAKER_GOOGLE_JOIN_MODE: "guest",
      NOTETAKER_CHROME_CHANNEL: "chrome-beta",
      NOTETAKER_CHROME_HEADLESS: "false",
      NOTETAKER_BOT_ADAPTER: "real",
      PATH: "/usr/bin",
    };
    const before = JSON.stringify(env);

    const result = probeConfigEnv(env);

    expect(JSON.stringify(env)).toBe(before);
    expect(result).not.toBe(env);
    expect(result.NOTETAKER_GOOGLE_JOIN_MODE).toBe("guest");
    expect(result.NOTETAKER_CHROME_CHANNEL).toBe("chrome-beta");
    expect(result.NOTETAKER_CHROME_HEADLESS).toBe("false");
    expect(result.PATH).toBe("/usr/bin");
  });
});

describe("meetProbePreflightRefusal", () => {
  it("allows a guest join with a free path", () => {
    expect(meetProbePreflightRefusal(options(), goodFacts())).toBeNull();
  });

  it("allows account mode with a stored session, or with both credentials", () => {
    expect(
      meetProbePreflightRefusal(options(), goodFacts({ joinMode: "account", hasStorageState: true }))
    ).toBeNull();
    expect(
      meetProbePreflightRefusal(
        options(),
        goodFacts({ joinMode: "account", hasAccountEmail: true, hasAccountPassword: true })
      )
    ).toBeNull();
  });

  it("refuses to overwrite an existing out file", () => {
    const message = meetProbePreflightRefusal(options(), goodFacts({ outFileExists: true }));

    expect(message).toContain(OUT);
    expect(message).toContain("will not be overwritten");
    expect(message?.endsWith("Nothing was joined.\n")).toBe(true);
  });

  it("refuses a missing or unwritable directory", () => {
    expect(meetProbePreflightRefusal(options(), goodFacts({ outDirectoryExists: false }))).toContain(
      "does not exist"
    );
    expect(meetProbePreflightRefusal(options(), goodFacts({ outDirectoryWritable: false }))).toContain(
      "not writable"
    );
  });

  it("names every missing account variable and none that is present", () => {
    const none = meetProbePreflightRefusal(options(), goodFacts({ joinMode: "account" }));
    expect(none).toContain("Not set: NOTETAKER_GOOGLE_ACCOUNT_EMAIL, NOTETAKER_GOOGLE_ACCOUNT_PASSWORD");

    const noPassword = meetProbePreflightRefusal(
      options(),
      goodFacts({ joinMode: "account", hasAccountEmail: true })
    );
    expect(noPassword).toContain("Not set: NOTETAKER_GOOGLE_ACCOUNT_PASSWORD.");
    expect(noPassword).not.toContain("Not set: NOTETAKER_GOOGLE_ACCOUNT_EMAIL");

    const noEmail = meetProbePreflightRefusal(
      options(),
      goodFacts({ joinMode: "account", hasAccountPassword: true })
    );
    expect(noEmail).toContain("Not set: NOTETAKER_GOOGLE_ACCOUNT_EMAIL.");
  });

  it("does not ask for credentials in guest mode", () => {
    expect(meetProbePreflightRefusal(options(), goodFacts({ joinMode: "guest" }))).toBeNull();
  });

  it("reports the file problem before the credential problem", () => {
    expect(
      meetProbePreflightRefusal(options(), goodFacts({ joinMode: "account", outFileExists: true }))
    ).toContain("already exists");
  });

  it("never contains the meeting URL", () => {
    const refusals = [
      goodFacts({ outFileExists: true }),
      goodFacts({ outDirectoryExists: false }),
      goodFacts({ outDirectoryWritable: false }),
      goodFacts({ joinMode: "account" }),
    ].map((facts) => meetProbePreflightRefusal(options(), facts));

    for (const refusal of refusals) {
      expect(refusal).not.toBeNull();
      expect(refusal).not.toContain("abc-defg-hij");
    }
  });
});

describe("resolveCredentialRoute", () => {
  it("names the route the join will take", () => {
    expect(resolveCredentialRoute({ joinMode: "guest", hasStorageState: true })).toBe("guest");
    expect(resolveCredentialRoute({ joinMode: "account", hasStorageState: true })).toBe("storage_state");
    expect(resolveCredentialRoute({ joinMode: "account", hasStorageState: false })).toBe("password");
  });
});

describe("exit codes and messages", () => {
  const outcomes: ProbeOutcome[] = [
    "completed",
    "interrupted",
    "denied",
    "removed",
    "meeting_ended",
    "connection_lost",
    "admit_timeout",
    "join_failed",
  ];

  it("maps every outcome to an exit code", () => {
    expect(exitCodeForOutcome("completed")).toBe(EXIT_OK);
    expect(exitCodeForOutcome("interrupted")).toBe(EXIT_INTERRUPTED);
    for (const outcome of outcomes.filter(
      (candidate) => candidate !== "completed" && candidate !== "interrupted"
    )) {
      expect(exitCodeForOutcome(outcome)).toBe(EXIT_FAILED);
    }
    expect([EXIT_OK, EXIT_FAILED, EXIT_INTERRUPTED]).toEqual([0, 1, 130]);
  });

  it("gives every outcome its own message, with and without a report", () => {
    expect(new Set(outcomes.map((outcome) => outcomeMessage(outcome, true))).size).toBe(outcomes.length);
    for (const outcome of outcomes) {
      expect(outcomeMessage(outcome, true)).not.toContain("No report was written");
      expect(outcomeMessage(outcome, false)).toContain("No report was written.");
      expect(outcomeMessage(outcome, true).startsWith("meet-probe: ")).toBe(true);
    }
  });

  it("builds the remaining messages without any URL or value", () => {
    expect(reportWrittenMessage(OUT)).toContain(OUT);
    expect(leakRefusalMessage(["meeting URL", "account email"])).toContain("meeting URL, account email");
    expect(leakRefusalMessage(["meeting URL"]).endsWith("Nothing was saved.\n")).toBe(true);
    expect(outFileWriteFailureMessage(OUT, "ENOSPC")).toContain("(ENOSPC)");
    expect(outFileWriteFailureMessage(OUT, null)).toContain("(unknown)");
    expect(outFileOpenFailureMessage(OUT, "EEXIST")).toContain("(EEXIST)");
    expect(configFailureMessage("Invalid configuration: X: must be set")).toBe(
      "meet-probe: Invalid configuration: X: must be set\n"
    );
    expect(UNEXPECTED_ERROR_MESSAGE.endsWith("\n")).toBe(true);
  });

  it("puts the message before the usage text on a usage error", () => {
    const output = usageErrorOutput("--out is required");

    expect(output.startsWith("meet-probe: --out is required\n\nUsage:")).toBe(true);
  });

  it("documents arguments, flags, ranges, defaults and variables in the usage text", () => {
    expect(
      MEET_PROBE_USAGE.startsWith(
        "Usage: yarn workspace @calcom/notetaker-bot meet-probe <meeting-url> --out <file>"
      )
    ).toBe(true);
    expect(MEET_PROBE_USAGE.endsWith("\n")).toBe(true);
    for (const fragment of [
      "--out <file>",
      "--duration <seconds>",
      "--interval-ms <ms>",
      "--admit-timeout <seconds>",
      "--redact-names",
      "--no-redact-names",
      "--no-notice",
      "--help",
      "10 to 600",
      "250 to 5000",
      "10 to 1800",
      "(default: 60)",
      "(default: 1000)",
      "(default: 300)",
      "0600",
      "absolute",
      "NOTETAKER_GOOGLE_JOIN_MODE",
      "NOTETAKER_GOOGLE_STORAGE_STATE_B64",
      "NOTETAKER_CHROME_CHANNEL",
      "NOTETAKER_CHROME_HEADLESS",
      "Ctrl+C",
    ]) {
      expect(MEET_PROBE_USAGE).toContain(fragment);
    }
    expect(MEET_PROBE_USAGE).not.toContain("meet.google.com/");
  });
});

describe("textual guards", () => {
  it("keeps Playwright out of the pure module", () => {
    const source = readFileSync(path.join(SCRIPTS_DIRECTORY, "meetProbePlan.ts"), "utf8");

    expect(source).not.toMatch(/["'`]playwright(?:-core)?["'`]/);
    expect(source).not.toContain("console.");
  });
});

// The probe script cannot run in a test, so its safety properties and those of its modules are checked as text.
describe("textual guards over every probe file", () => {
  const MARKER = "UNVERIFIED AGAINST THE REAL SERVICE";
  const MARKED_PROBE_FILES = ["meet-probe.ts", "meetProbePageScript.ts"];
  const IMPORT_SPECIFIER =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["'`]([^"'`\n]+)["'`]|\b(?:import|require)\s*\(\s*["'`]([^"'`\n]+)["'`]/g;

  const probeFiles = readdirSync(SCRIPTS_DIRECTORY)
    .filter((name) => name === "meet-probe.ts" || /^meetProbe.*\.ts$/.test(name))
    .filter((name) => !name.endsWith(".test.ts"))
    .sort();
  const readProbeFile = (name: string): string => readFileSync(path.join(SCRIPTS_DIRECTORY, name), "utf8");

  it("finds the script and its modules", () => {
    expect(probeFiles).toEqual([
      "meet-probe.ts",
      "meetProbeHash.ts",
      "meetProbePageScript.ts",
      "meetProbePlan.ts",
      "meetProbeRecorder.ts",
      "meetProbeRedaction.ts",
      "meetProbeReport.ts",
      "meetProbeRun.ts",
      "meetProbeTypes.ts",
    ]);
  });

  it.each(MARKED_PROBE_FILES)("marks %s as unverified in its header", (name) => {
    const header = readProbeFile(name).split("\n").slice(0, 4).join("\n");

    expect(header.startsWith(`// ${MARKER} (`)).toBe(true);
    expect(header).toContain("docs/smoke-test-google-meet.md section 12");
    expect(header).toContain("docs/verification-status.md");
  });

  it.each([
    "recordVideo",
    "recordHar",
    "tracing.start",
    ".screenshot(",
    ".pdf(",
    "storageState(",
    "console.",
  ])("keeps %s out of every probe file", (needle) => {
    for (const name of probeFiles) {
      expect(readProbeFile(name).includes(needle), `${name} contains ${needle}`).toBe(false);
    }
  });

  it("imports Playwright in no probe file", () => {
    for (const name of probeFiles) {
      const specifiers = [...readProbeFile(name).matchAll(IMPORT_SPECIFIER)].map(
        (match) => match[1] ?? match[2] ?? ""
      );

      expect(specifiers.length, `${name} has no imports to check`).toBeGreaterThan(0);
      expect(
        specifiers.filter((specifier) => specifier.includes("playwright")),
        `${name} imports Playwright`
      ).toEqual([]);
    }
  });
});
