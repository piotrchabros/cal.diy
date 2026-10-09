import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { notetakerBotJoinRequestSchema, notetakerBotStateSchema } from "@calcom/lib/notetaker/botContract";
import type { RunnerStatus } from "./MeetingRunnerLauncher";

export const RUNNER_STATUS_PREFIX = "@@notetaker-status ";
export const RUNNER_JOIN_REQUEST_ENV = "NOTETAKER_RUNNER_JOIN_REQUEST";

const runnerStatusSchema = notetakerBotStateSchema.pick({ phase: true, lastEventSequence: true });

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LINE_BREAK_PATTERN = /\r\n|\n|\r/;

export function encodeRunnerStatus(status: RunnerStatus): string {
  return `${RUNNER_STATUS_PREFIX}${JSON.stringify({
    phase: status.phase,
    lastEventSequence: status.lastEventSequence,
  })}`;
}

export function parseRunnerStatusLine(line: string): RunnerStatus | null {
  // Docker log streams and terminals can prepend header bytes or timestamps to the line.
  const prefixIndex = line.lastIndexOf(RUNNER_STATUS_PREFIX);
  if (prefixIndex === -1) return null;

  const body = line.slice(prefixIndex + RUNNER_STATUS_PREFIX.length).trim();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }

  const parsed = runnerStatusSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function findLastRunnerStatus(text: string): RunnerStatus | null {
  const lines = text.split(LINE_BREAK_PATTERN);
  for (const line of lines.reverse()) {
    const status = parseRunnerStatusLine(line);
    if (status) return status;
  }
  return null;
}

export function encodeJoinRequestEnv(request: NotetakerBotJoinRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

export function decodeJoinRequestEnv(value: string | undefined): NotetakerBotJoinRequest {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new Error(`${RUNNER_JOIN_REQUEST_ENV} must be set`);
  }

  const notBase64Json = `${RUNNER_JOIN_REQUEST_ENV} must be base64 of a JSON join request`;
  // Buffer.from never throws on bad base64, so the alphabet is checked up front.
  if (!BASE64_PATTERN.test(trimmed)) throw new Error(notBase64Json);

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    throw new Error(notBase64Json);
  }

  const parsed = notetakerBotJoinRequestSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  const paths = [
    ...new Set(
      parsed.error.issues.map((issue) => (issue.path.length === 0 ? "(root)" : issue.path.join(".")))
    ),
  ].sort();
  throw new Error(
    `${RUNNER_JOIN_REQUEST_ENV} is not a valid join request; invalid fields: ${paths.join(", ")}`
  );
}
