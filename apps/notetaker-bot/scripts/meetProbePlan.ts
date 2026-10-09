import path from "node:path";
import { parseArgs } from "node:util";
import { isJoinableMeetingUrl } from "../src/platform/meetingUrl";
import type { MeetProbeOptions, ProbeCredentialRoute, ProbeJoinMode, ProbeOutcome } from "./meetProbeTypes";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_INTERRUPTED = 130;

export const DEFAULT_DURATION_SECONDS = 60;
export const DEFAULT_INTERVAL_MS = 1000;
export const DEFAULT_ADMIT_TIMEOUT_SECONDS = 300;
export const DURATION_RANGE_SECONDS = { min: 10, max: 600 } as const;
export const INTERVAL_RANGE_MS = { min: 250, max: 5000 } as const;
export const ADMIT_TIMEOUT_RANGE_SECONDS = { min: 10, max: 1800 } as const;

export const STORAGE_STATE_VARIABLE = "NOTETAKER_GOOGLE_STORAGE_STATE_B64";
export const ACCOUNT_EMAIL_VARIABLE = "NOTETAKER_GOOGLE_ACCOUNT_EMAIL";
export const ACCOUNT_PASSWORD_VARIABLE = "NOTETAKER_GOOGLE_ACCOUNT_PASSWORD";

const PLACEHOLDER_BOT_SECRET = "meet-probe-placeholder-secret-not-real";

// Variables of the runner configuration that the probe has no use for and that could make
// getRunnerConfig refuse a run which never touches them (fake adapter, no speech-to-text).
const IGNORED_CONFIG_VARIABLES: readonly string[] = [
  "SONIOX_API_KEY",
  "SONIOX_WS_URL",
  "SONIOX_MODEL",
  "NOTETAKER_FAKE_MEETING_SECONDS",
  "NODE_ENV",
];

export const MEET_PROBE_USAGE = `Usage: yarn workspace @calcom/notetaker-bot meet-probe <meeting-url> --out <file> [options]

Joins a Google Meet exactly as the bot does, watches the page for a while, leaves, and writes one JSON
report about the leave control and the speaker indicators. The bot appears in the meeting like any
participant, so tell the people in it.

Arguments:
  <meeting-url>             The Google Meet link to join (meet.google.com). It is never written to the report.

Flags:
  --out <file>              Where to write the report. The path must be absolute and the file must not exist
                            yet; it is created with mode 0600. Required.
  --duration <seconds>      How long to observe after being admitted, ${DURATION_RANGE_SECONDS.min} to ${DURATION_RANGE_SECONDS.max} (default: ${DEFAULT_DURATION_SECONDS}).
  --interval-ms <ms>        Time between page samples, ${INTERVAL_RANGE_MS.min} to ${INTERVAL_RANGE_MS.max} (default: ${DEFAULT_INTERVAL_MS}).
  --admit-timeout <seconds> How long to wait to be admitted, ${ADMIT_TIMEOUT_RANGE_SECONDS.min} to ${ADMIT_TIMEOUT_RANGE_SECONDS.max} (default: ${DEFAULT_ADMIT_TIMEOUT_SECONDS}).
  --redact-names            Replace participant names with stable aliases in the report (the default).
  --no-redact-names         Keep participant names as they appear on the page. Give at most one of the two.
  --no-notice               Do not post the one-line diagnostic notice in the meeting chat.
  --help                    Show this help

Environment (the bot's own variables; no .env file is read):
  NOTETAKER_GOOGLE_JOIN_MODE          guest (default) or account
  ${STORAGE_STATE_VARIABLE}   session for account mode
  ${ACCOUNT_EMAIL_VARIABLE}      account mode without a session, together with the password
  ${ACCOUNT_PASSWORD_VARIABLE}   account mode without a session, together with the email
  NOTETAKER_CHROME_CHANNEL            Chrome channel to launch (default: chrome)
  NOTETAKER_CHROME_HEADLESS           true or false (default: false)

Press Ctrl+C to end the observation early; the probe still leaves the meeting and writes the report.
The report holds no meeting URL, credential, chat text or audio. Without --no-redact-names it holds no
participant names either.
`;

export function usageErrorOutput(message: string): string {
  return `meet-probe: ${message}\n\n${MEET_PROBE_USAGE}`;
}

type ParsedFlags = {
  out?: string;
  duration?: string;
  "interval-ms"?: string;
  "admit-timeout"?: string;
  "redact-names"?: boolean;
  "no-redact-names"?: boolean;
  "no-notice"?: boolean;
  help?: boolean;
};

type ParsedArguments = { values: ParsedFlags; positionals: string[] };

// Node's own messages can quote the offending argument, and a mistyped flag may carry the meeting URL
// (`--oops=<url>`), so only the flag name is taken from them.
function describeParseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  const flag = /'(--?[A-Za-z][A-Za-z0-9-]*)/.exec(message)?.[1];
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return flag === undefined ? "unknown option" : `unknown option ${flag}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return flag === undefined ? "an option is missing its value" : `${flag} needs a value`;
  }
  return "the arguments could not be read";
}

function readArguments(argv: string[]): ParsedArguments {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        duration: { type: "string" },
        "interval-ms": { type: "string" },
        "admit-timeout": { type: "string" },
        "redact-names": { type: "boolean" },
        "no-redact-names": { type: "boolean" },
        "no-notice": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    return { values, positionals };
  } catch (error) {
    throw new Error(describeParseFailure(error));
  }
}

function readInteger(
  flag: string,
  raw: string | undefined,
  fallback: number,
  range: { min: number; max: number }
): number {
  if (raw === undefined) return fallback;
  const rule = `${flag} must be a whole number from ${range.min} to ${range.max}`;
  if (!/^\d{1,9}$/.test(raw)) throw new Error(rule);
  const value = Number.parseInt(raw, 10);
  if (value < range.min || value > range.max) throw new Error(rule);
  return value;
}

export function parseMeetProbeArgs(argv: string[]): MeetProbeOptions {
  const { values, positionals } = readArguments(argv);
  if (values.help === true) {
    return {
      meetingUrl: "",
      outFile: "",
      durationSeconds: DEFAULT_DURATION_SECONDS,
      intervalMs: DEFAULT_INTERVAL_MS,
      admitTimeoutSeconds: DEFAULT_ADMIT_TIMEOUT_SECONDS,
      redactNames: true,
      postNotice: true,
      help: true,
    };
  }

  if (positionals.length > 1) throw new Error("only one meeting URL is accepted");
  const meetingUrl = positionals[0];
  if (meetingUrl === undefined) throw new Error("the meeting URL is missing");
  // The URL is never echoed: it carries the meeting code.
  if (!isJoinableMeetingUrl("GOOGLE_MEET", meetingUrl)) {
    throw new Error("the meeting URL must be a Google Meet link on meet.google.com");
  }

  const out = values.out;
  if (out === undefined) throw new Error("--out is required");
  if (out === "") throw new Error("--out needs a file path");
  // `yarn workspace ... <script>` runs with the workspace as its working directory, so a relative
  // path would put the report inside the repository.
  if (!path.isAbsolute(out)) throw new Error("--out must be an absolute path");

  const durationSeconds = readInteger(
    "--duration",
    values.duration,
    DEFAULT_DURATION_SECONDS,
    DURATION_RANGE_SECONDS
  );
  const intervalMs = readInteger(
    "--interval-ms",
    values["interval-ms"],
    DEFAULT_INTERVAL_MS,
    INTERVAL_RANGE_MS
  );
  const admitTimeoutSeconds = readInteger(
    "--admit-timeout",
    values["admit-timeout"],
    DEFAULT_ADMIT_TIMEOUT_SECONDS,
    ADMIT_TIMEOUT_RANGE_SECONDS
  );

  if (values["redact-names"] === true && values["no-redact-names"] === true) {
    throw new Error("--redact-names and --no-redact-names cannot be used together");
  }

  return {
    meetingUrl,
    outFile: out,
    durationSeconds,
    intervalMs,
    admitTimeoutSeconds,
    redactNames: values["no-redact-names"] !== true,
    postNotice: values["no-notice"] !== true,
    help: false,
  };
}

// The probe only needs the bot's Google join and Chrome variables, so everything else getRunnerConfig
// insists on is filled in with values that cannot be used for anything real. The fake adapter makes the
// speech-to-text provider unnecessary; it is never started either way.
export function probeConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!IGNORED_CONFIG_VARIABLES.includes(key)) overlay[key] = value;
  }
  overlay.NOTETAKER_BOT_ADAPTER = "fake";
  overlay.NOTETAKER_BOT_SECRET = PLACEHOLDER_BOT_SECRET;
  return overlay;
}

export type MeetProbePreflightFacts = {
  outFileExists: boolean;
  outDirectoryExists: boolean;
  outDirectoryWritable: boolean;
  joinMode: ProbeJoinMode;
  hasStorageState: boolean;
  hasAccountEmail: boolean;
  hasAccountPassword: boolean;
};

export function resolveCredentialRoute(
  facts: Pick<MeetProbePreflightFacts, "joinMode" | "hasStorageState">
): ProbeCredentialRoute {
  if (facts.joinMode === "guest") return "guest";
  return facts.hasStorageState ? "storage_state" : "password";
}

// Only variable names are ever put into a refusal, never values.
export function meetProbePreflightRefusal(
  options: MeetProbeOptions,
  facts: MeetProbePreflightFacts
): string | null {
  if (facts.outFileExists) {
    return `meet-probe: ${options.outFile} already exists and will not be overwritten. Delete it or choose another path. Nothing was joined.\n`;
  }
  if (!facts.outDirectoryExists) {
    return `meet-probe: the directory of ${options.outFile} does not exist. Create it or choose another path. Nothing was joined.\n`;
  }
  if (!facts.outDirectoryWritable) {
    return `meet-probe: the directory of ${options.outFile} is not writable. Choose another path. Nothing was joined.\n`;
  }

  if (facts.joinMode === "account" && !facts.hasStorageState) {
    const missing: string[] = [];
    if (!facts.hasAccountEmail) missing.push(ACCOUNT_EMAIL_VARIABLE);
    if (!facts.hasAccountPassword) missing.push(ACCOUNT_PASSWORD_VARIABLE);
    if (missing.length > 0) {
      return `meet-probe: NOTETAKER_GOOGLE_JOIN_MODE is account, which needs ${STORAGE_STATE_VARIABLE}, or both ${ACCOUNT_EMAIL_VARIABLE} and ${ACCOUNT_PASSWORD_VARIABLE}. Not set: ${missing.join(", ")}. Nothing was joined.\n`;
    }
  }
  return null;
}

export function exitCodeForOutcome(outcome: ProbeOutcome): number {
  if (outcome === "completed") return EXIT_OK;
  if (outcome === "interrupted") return EXIT_INTERRUPTED;
  return EXIT_FAILED;
}

const OUTCOME_DETAILS: Record<ProbeOutcome, string> = {
  completed: "the observation window ran to its end and the bot left.",
  interrupted: "the observation was ended early and the bot left.",
  denied: "the host did not admit the bot, so there is nothing to observe in the call.",
  removed: "the bot was removed from the meeting before the observation ended.",
  meeting_ended: "the meeting ended before the observation ended.",
  connection_lost: "the connection to the meeting was lost before the observation ended.",
  admit_timeout: "the bot was not admitted in time and gave up.",
  join_failed: "the bot could not join the meeting.",
};

export function outcomeMessage(outcome: ProbeOutcome, reportWritten: boolean): string {
  const tail = reportWritten ? "" : " No report was written.";
  return `meet-probe: ${OUTCOME_DETAILS[outcome]}${tail}\n`;
}

export function reportWrittenMessage(outFile: string): string {
  return `meet-probe: wrote the report to ${outFile} (mode 0600). Review it before sharing it.\n`;
}

// Labels are fixed words such as "meeting URL" or "participant name", never the leaked values.
export function leakRefusalMessage(labels: readonly string[]): string {
  return `meet-probe: the report would contain ${labels.join(", ")}, so it was not written. Nothing was saved.\n`;
}

export function configFailureMessage(errorMessage: string): string {
  return `meet-probe: ${errorMessage}\n`;
}

export function outFileWriteFailureMessage(outFile: string, errorCode: string | null): string {
  return `meet-probe: could not write ${outFile} (${errorCode ?? "unknown"}). The report was not saved.\n`;
}

export function outFileOpenFailureMessage(outFile: string, errorCode: string | null): string {
  return `meet-probe: could not create ${outFile} (${errorCode ?? "unknown"}). Nothing was joined.\n`;
}

export const UNEXPECTED_ERROR_MESSAGE = "meet-probe: unexpected error. No report was written.\n";
