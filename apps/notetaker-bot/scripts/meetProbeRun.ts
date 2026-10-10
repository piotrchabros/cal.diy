// Decisions of one Meet probe run that need no browser, clock, signal or file: what the script records, which
// outcome it reports and what the leak check looks for. Pure, so they are tested without a meeting.

import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import { sourceIdOfKey } from "./meetProbeHash";
import { IN_CALL_SELECTOR_KEYS } from "./meetProbeRecorder";
import type { LeakSecret } from "./meetProbeRedaction";
import type {
  MeetSelectorKey,
  ProbeOutcome,
  RawAdapterLogLine,
  RawAfterLeaveObservation,
  RawLeaveStep,
  RawPageSample,
  RawPlatformEvent,
  RecordedPageCall,
} from "./meetProbeTypes";

// Meet labels the bot's own tile "You"; it is not a participant name.
const SELF_TILE_LABEL = "you";

const FULL_SWEEP_EVERY_TICKS = 5;
const SPEAKER_SWEEP_KEYS: readonly MeetSelectorKey[] = ["activeSpeakerName"];

const TERMINAL_OUTCOMES: Partial<Record<PlatformEvent["type"], ProbeOutcome>> = {
  denied: "denied",
  removed: "removed",
  meeting_ended: "meeting_ended",
  connection_lost: "connection_lost",
};

// A shorter identifier also occurs as a count or a time in the report and would refuse a clean run.
export const MIN_IDENTIFIER_SECRET_LENGTH = 8;

const NAME_PARTICIPANT_PREFIX = "name:";
const ALL_DIGITS = /^[0-9]+$/;

export const PROBE_DISPLAY_NAME = "Notetaker diagnostic probe";

export type ProbeRunState = {
  // False when adapter.join rejected.
  joined: boolean;
  admitted: boolean;
  interrupted: boolean;
  terminal: ProbeOutcome | null;
};

export type ProbeSecretSources = {
  meetingUrl: string;
  accountEmail: string | null;
  accountPassword: string | null;
  // The storage-state variable exactly as the environment holds it.
  storageStateValue: string | undefined;
  redactNames: boolean;
  rawNames: readonly string[];
  salt: string;
  rawParticipantIds: readonly string[];
  rawSourceIds: readonly string[];
};

export type ProbeRawIdentifiers = {
  participantIds: string[];
  sourceIds: string[];
};

export function toLogLine(line: string, tMs: number): RawAdapterLogLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const entry: RawAdapterLogLine = { tMs, level: "unknown", message: "", fields: {} };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "time") continue;
    if (key === "level" && typeof value === "string") entry.level = value;
    else if (key === "message" && typeof value === "string") entry.message = value;
    else if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      entry.fields[key] = value;
    }
  }
  return entry;
}

// Every raw name the run saw, so the leak check can prove none reached the file. Whole names only: a single
// word of a name ("Google", "Chrome", "Call") also occurs in the report's fixed text and would refuse a clean run.
export function collectRawNames(events: RawPlatformEvent[], samples: RawPageSample[]): string[] {
  const names = new Set<string>();
  const add = (value: string): void => {
    const whole = value.trim();
    const lowered = whole.toLowerCase();
    // The probe's own display name is not private.
    if (whole === "" || lowered === SELF_TILE_LABEL || lowered === PROBE_DISPLAY_NAME.toLowerCase()) return;
    names.add(whole);
  };

  for (const { event } of events) {
    if (event.type === "speaker" || event.type === "source_identity") add(event.name);
  }
  for (const sample of samples) {
    for (const tile of sample.tiles) {
      for (const entry of tile.strings) {
        if (entry.isNotranslateSpan) add(entry.value);
      }
    }
  }
  return [...names];
}

// The ids the adapter emitted in its own platform events; the report must hold only their hashes.
export function collectRawIdentifiers(events: RawPlatformEvent[]): ProbeRawIdentifiers {
  const participantIds = new Set<string>();
  const sourceIds = new Set<string>();

  for (const { event } of events) {
    if (event.type === "speaker" || event.type === "source_identity") {
      if (!event.participantId.startsWith(NAME_PARTICIPANT_PREFIX)) participantIds.add(event.participantId);
    }
    if (event.type === "source_activity" || event.type === "source_identity") {
      const sourceId = sourceIdOfKey(event.sourceKey);
      if (sourceId !== null) sourceIds.add(sourceId);
    }
  }
  return { participantIds: [...participantIds], sourceIds: [...sourceIds] };
}

export function meetingCodeOf(meetingUrl: string): string | null {
  return new URL(meetingUrl).pathname.split("/").filter(Boolean).at(-1) ?? null;
}

export function buildSecrets(sources: ProbeSecretSources): LeakSecret[] {
  const meetingCode = meetingCodeOf(sources.meetingUrl);
  const secrets: LeakSecret[] = [{ label: "meeting URL", value: sources.meetingUrl }];
  if (meetingCode !== null) secrets.push({ label: "meeting code", value: meetingCode });
  if (sources.accountEmail !== null) secrets.push({ label: "account email", value: sources.accountEmail });
  if (sources.accountPassword !== null) {
    secrets.push({ label: "account password", value: sources.accountPassword });
  }
  if (sources.storageStateValue !== undefined) {
    secrets.push({ label: "storage state", value: sources.storageStateValue });
  }
  if (sources.redactNames) {
    // A name is ordinary words, so only a whole-token match means it leaked; the secrets above are opaque
    // values and stay substring matches.
    for (const name of sources.rawNames) {
      secrets.push({ label: "participant name", value: name, match: "token" });
    }
  }
  secrets.push({ label: "probe salt", value: sources.salt });
  for (const id of sources.rawParticipantIds) {
    if (id.length >= MIN_IDENTIFIER_SECRET_LENGTH) secrets.push({ label: "participant id", value: id });
  }
  for (const id of sources.rawSourceIds) {
    if (id.length < MIN_IDENTIFIER_SECRET_LENGTH) continue;
    // A number leaked only as a whole token; digits inside a longer number or a hash are not the id.
    if (ALL_DIGITS.test(id)) secrets.push({ label: "audio source id", value: id, match: "token" });
    else secrets.push({ label: "audio source id", value: id });
  }
  return secrets;
}

export function terminalOutcomeOf(event: PlatformEvent): ProbeOutcome | null {
  return TERMINAL_OUTCOMES[event.type] ?? null;
}

export function resolveOutcome(state: ProbeRunState): ProbeOutcome {
  if (!state.joined) return "join_failed";
  if (state.terminal !== null) return state.terminal;
  if (state.interrupted) return "interrupted";
  return state.admitted ? "completed" : "admit_timeout";
}

export function sweepKeysForTick(tick: number): readonly MeetSelectorKey[] {
  return tick % FULL_SWEEP_EVERY_TICKS === 0 ? IN_CALL_SELECTOR_KEYS : SPEAKER_SWEEP_KEYS;
}

export function afterLeaveStep(input: {
  leaveStartMs: number;
  leaveElapsedMs: number;
  pageCalls: readonly RecordedPageCall[];
  afterLeave: RawAfterLeaveObservation | null;
}): RawLeaveStep | null {
  if (input.afterLeave === null) return null;
  // The recording page observes first and records its close call right after, so the close marks the end.
  const closeCall = input.pageCalls.filter((call) => call.method === "close").at(-1);
  const endMs = closeCall ? closeCall.tMs : input.leaveStartMs + input.leaveElapsedMs;
  return {
    tMs: Math.max(input.leaveStartMs, endMs - input.afterLeave.observedMs),
    label: "after-leave",
    durationMs: input.afterLeave.observedMs,
  };
}
