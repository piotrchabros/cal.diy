import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type { NotetakerBotEndReason, NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import { notetakerBotEndReasonSchema } from "@calcom/lib/notetaker/botContract";

export type FakeEventsStage = "admitted" | "passages" | "ended";

export type FakeEventsOptions = {
  sessionId: string;
  until: FakeEventsStage;
  endReason: NotetakerBotEndReason;
  skipPassages: boolean;
  badSignature: boolean;
  replayLast: boolean;
  timestampOffsetSeconds: number;
  url: string | null;
  envFile: string | null;
  help: boolean;
};

export type FakeEventRequest = {
  sequence: number;
  type: NotetakerBotEvent["type"];
  rawBody: string;
};

const STAGES: readonly FakeEventsStage[] = ["admitted", "passages", "ended"];
const DEFAULT_URL_BASE = "http://localhost:3000";
const FAKE_PASSAGE_COUNT = 3;

export const FAKE_EVENTS_USAGE = `Usage: yarn workspace @calcom/notetaker-bot fake-events --session <sessionId> [flags]

Posts signed fake notetaker bot events to the web app.

Flags:
  --session <id>              Notetaker session id (required)
  --until <stage>             Last stage to send: admitted | passages | ended (default: ended)
  --end-reason <reason>       End reason of the final event, one of: ${notetakerBotEndReasonSchema.options.join(", ")} (default: MEETING_ENDED)
  --skip-passages             Leave out the transcript passages event (default: off)
  --bad-signature             Send an invalid signature (default: off)
  --replay-last               Send the last event a second time (default: off)
  --timestamp-offset <secs>   Shift the signed timestamp by this many seconds (default: 0)
  --url <url>                 Events endpoint (default: see URL rule)
  --env-file <path>           Env file to read the secret from (default: repository root .env)
  --help                      Show this help

URL rule: --url, else \${NEXT_PUBLIC_WEBAPP_URL or http://localhost:3000}/api/notetaker/events.
Secret: NOTETAKER_BOT_SECRET from the environment, else from --env-file or the repository root .env.

Notes:
  A negative offset needs the = form: --timestamp-offset=-400.
  A stale-timestamp check needs an absolute offset above 300 seconds.
  Every run starts at sequence 1 with the same event ids, so a later run for the same session
  replays the earlier events.

Example:
  After "--until admitted", post a stop with:
  --session <id> --until ended --skip-passages --end-reason STOP_REQUESTED
`;

export function parseFakeEventsArgs(argv: string[]): FakeEventsOptions {
  const values = readFlags(argv);

  if (values.help === true) {
    return {
      sessionId: "",
      until: "ended",
      endReason: "MEETING_ENDED",
      skipPassages: false,
      badSignature: false,
      replayLast: false,
      timestampOffsetSeconds: 0,
      url: null,
      envFile: null,
      help: true,
    };
  }

  return {
    sessionId: parseSession(values.session),
    until: parseStage(values.until),
    endReason: parseEndReason(values["end-reason"]),
    skipPassages: values["skip-passages"] === true,
    badSignature: values["bad-signature"] === true,
    replayLast: values["replay-last"] === true,
    timestampOffsetSeconds: parseOffset(values["timestamp-offset"]),
    url: parseUrl(values.url),
    envFile: values["env-file"] ?? null,
    help: false,
  };
}

function readFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        session: { type: "string" },
        until: { type: "string" },
        "end-reason": { type: "string" },
        "timestamp-offset": { type: "string" },
        url: { type: "string" },
        "env-file": { type: "string" },
        "skip-passages": { type: "boolean" },
        "bad-signature": { type: "boolean" },
        "replay-last": { type: "boolean" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function parseSession(value: string | undefined): string {
  if (value === undefined || value === "") throw new Error("--session is required and must not be empty");
  return value;
}

function parseStage(value: string | undefined): FakeEventsStage {
  if (value === undefined) return "ended";
  const stage = STAGES.find((candidate) => candidate === value);
  if (stage === undefined) throw new Error(`--until must be one of: ${STAGES.join(", ")} (got "${value}")`);
  return stage;
}

function parseEndReason(value: string | undefined): NotetakerBotEndReason {
  if (value === undefined) return "MEETING_ENDED";
  const parsed = notetakerBotEndReasonSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `--end-reason must be one of: ${notetakerBotEndReasonSchema.options.join(", ")} (got "${value}")`
    );
  }
  return parsed.data;
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^-?\d+$/.test(value)) throw new Error(`--timestamp-offset must be an integer (got "${value}")`);
  return Number.parseInt(value, 10);
}

function parseUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`--url must be a valid http or https URL (got "${value}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--url must use http or https (got "${value}")`);
  }
  return value;
}

// Deterministic so a later run for the same session re-sends the same ids and the server dedupes them.
export function deterministicEventId(sessionId: string, sequence: number): string {
  const h = createHash("sha256").update(`${sessionId}:${sequence}`).digest("hex");
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type EventEnvelope = { eventId: string; sessionId: string; sequence: number; occurredAt: string };

function envelope(options: FakeEventsOptions, now: Date, sequence: number): EventEnvelope {
  return {
    eventId: deterministicEventId(options.sessionId, sequence),
    sessionId: options.sessionId,
    sequence,
    occurredAt: now.toISOString(),
  };
}

function passagesEvent(options: FakeEventsOptions, now: Date): NotetakerBotEvent {
  return {
    ...envelope(options, now, 4),
    type: "transcript.passages",
    data: {
      passages: [
        {
          index: 0,
          speakerKey: "participant:fake-1",
          speakerName: "Example Person One",
          unknownSpeakerNumber: null,
          startMs: 1000,
          endMs: 4500,
          text: "This is fake example text, not a real transcript.",
          language: "en",
        },
        {
          index: 1,
          speakerKey: "participant:fake-2",
          speakerName: "Example Person Two",
          unknownSpeakerNumber: null,
          startMs: 5000,
          endMs: 8000,
          text: "Fake reply used only for testing the events endpoint.",
          language: "en",
        },
        {
          index: 2,
          speakerKey: "unknown:1",
          speakerName: null,
          unknownSpeakerNumber: 1,
          startMs: 8500,
          endMs: 11500,
          text: "Fake remark from a speaker the bot could not name.",
          language: "en",
        },
      ],
    },
  };
}

function endedEvent(options: FakeEventsOptions, now: Date): NotetakerBotEvent {
  return {
    ...envelope(options, now, 5),
    type: "session.ended",
    data: {
      endReason: options.endReason,
      durationMs: 12000,
      interruptedAtMs: null,
      passageCount: options.skipPassages ? 0 : FAKE_PASSAGE_COUNT,
    },
  };
}

// Sequence numbers are fixed per event type and never renumbered when events are skipped,
// so a later run with a longer --until continues the same series instead of colliding with it.
export function buildFakeEvents(options: FakeEventsOptions, now: Date): NotetakerBotEvent[] {
  const events: NotetakerBotEvent[] = [
    { ...envelope(options, now, 1), type: "session.join_requested", data: {} },
    { ...envelope(options, now, 2), type: "session.admitted", data: {} },
  ];
  if (options.until === "admitted") return events;

  events.push({ ...envelope(options, now, 3), type: "session.notice_posted", data: {} });
  if (!options.skipPassages) events.push(passagesEvent(options, now));
  if (options.until === "ended") events.push(endedEvent(options, now));
  return events;
}

export function buildFakeEventRequests(options: FakeEventsOptions, now: Date): FakeEventRequest[] {
  const requests = buildFakeEvents(options, now).map((event) => ({
    sequence: event.sequence,
    type: event.type,
    rawBody: JSON.stringify(event),
  }));
  const last = requests[requests.length - 1];
  if (options.replayLast && last !== undefined) requests.push({ ...last });
  return requests;
}

export function resolveFakeEventsUrl(options: FakeEventsOptions, webappUrl: string | undefined): string {
  if (options.url !== null) return options.url;
  return `${(webappUrl ?? DEFAULT_URL_BASE).replace(/\/+$/, "")}/api/notetaker/events`;
}
