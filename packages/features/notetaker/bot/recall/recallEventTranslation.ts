import type {
  NotetakerBotEndReason,
  NotetakerBotEvent,
  NotetakerBotPassage,
  NotetakerBotStateDto,
} from "@calcom/lib/notetaker/botContract";
import type { NotetakerConfig } from "../../lib/config";
import {
  PARTICIPANT_SPEAKER_KEY_PREFIX,
  UNKNOWN_SPEAKER_KEY_PREFIX,
} from "../../services/NotetakerSessionEventService";
import type { RecallBot, RecallRecording, RecallStatusChange, RecallTranscriptEntry } from "./recallSchemas";

// Recall sends no sequence numbers, so each lifecycle step gets a fixed one and a replayed sync is a DUPLICATE.
export const RECALL_EVENT_SEQUENCE = {
  JOIN_REQUESTED: 10,
  ADMITTED: 20,
  NOTICE_POSTED: 30,
  PASSAGES_BASE: 1000,
  ENDED: 1_000_000_000,
} as const;

// Recall transcribes after the meeting, so the watchdog must outlast the whole post-meeting processing.
export const RECALL_POST_MEETING_GRACE_SECONDS = 3600;

const MAX_PASSAGE_TEXT_LENGTH = 1000;
const MAX_PASSAGES_PER_EVENT = 50;
const MAX_SPEAKER_NAME_LENGTH = 200;

const ADMITTED_CODES = new Set([
  "in_call_not_recording",
  "in_call_recording",
  "recording_permission_allowed",
]);
const IN_MEETING_CODES = new Set([
  "in_call_not_recording",
  "in_call_recording",
  "recording_permission_allowed",
  "recording_permission_denied",
]);
const PRE_JOIN_CODES = new Set(["ready", "joining_call"]);

const CALL_ENDED_REASONS: Record<string, NotetakerBotEndReason> = {
  call_ended_by_host: "MEETING_ENDED",
  call_ended_by_platform_idle: "MEETING_ENDED",
  timeout_exceeded_everyone_left: "ALONE_TIMEOUT",
  timeout_exceeded_silence_detected: "ALONE_TIMEOUT",
  timeout_exceeded_only_bots_detected_using_participant_names: "ALONE_TIMEOUT",
  timeout_exceeded_only_bots_detected_using_participant_events: "ALONE_TIMEOUT",
  call_ended_by_platform_max_length: "LENGTH_LIMIT_REACHED",
  timeout_exceeded_in_call_recording: "LENGTH_LIMIT_REACHED",
  timeout_exceeded_waiting_room: "NOT_ADMITTED",
  call_ended_by_platform_waiting_room_timeout: "NOT_ADMITTED",
  bot_kicked_from_waiting_room: "NOT_ADMITTED",
  timeout_exceeded_noone_joined: "MEETING_DID_NOT_START",
  meeting_not_started: "MEETING_DID_NOT_START",
  bot_kicked_from_call: "REMOVED_BY_PARTICIPANT",
  timeout_exceeded_in_call_not_recording: "INTERRUPTED",
  timeout_exceeded_recording_permission_denied: "INTERRUPTED",
};

const FATAL_REASONS: Record<string, NotetakerBotEndReason> = {
  meeting_not_found: "MEETING_LINK_UNUSABLE",
  meeting_link_invalid: "MEETING_LINK_UNUSABLE",
  meeting_link_expired: "MEETING_LINK_UNUSABLE",
  meeting_requires_registration: "MEETING_LINK_UNUSABLE",
  meeting_requires_sign_in: "MEETING_LINK_UNUSABLE",
  meeting_password_incorrect: "MEETING_LINK_UNUSABLE",
  meeting_not_accessible: "MEETING_LINK_UNUSABLE",
  google_meet_knocking_disabled: "MEETING_LINK_UNUSABLE",
  google_meet_organisation_restricted: "MEETING_LINK_UNUSABLE",
  google_meet_bot_blocked: "MEETING_LINK_UNUSABLE",
  microsoft_teams_sign_in_credentials_missing: "MEETING_LINK_UNUSABLE",
  microsoft_teams_bot_not_invited: "MEETING_LINK_UNUSABLE",
  microsoft_teams_captcha_error: "MEETING_LINK_UNUSABLE",
  microsoft_teams_townhall_meeting_not_supported: "MEETING_LINK_UNUSABLE",
  meeting_not_started: "MEETING_DID_NOT_START",
  meeting_ended: "MEETING_DID_NOT_START",
  microsoft_teams_event_not_started_for_external: "MEETING_DID_NOT_START",
  meeting_locked: "NOT_ADMITTED",
  meeting_full: "NOT_ADMITTED",
};

type EventIdFactory = () => string;

function defaultEventId(): string {
  return crypto.randomUUID();
}

function latestStatusChange(bot: RecallBot): RecallStatusChange | null {
  return bot.status_changes.length > 0 ? bot.status_changes[bot.status_changes.length - 1] : null;
}

export function getRecallLivenessTimeoutSeconds(limits: NotetakerConfig["limits"]): number {
  return (
    limits.joinLeadSeconds +
    limits.noShowTimeoutSeconds +
    limits.admissionTimeoutSeconds +
    limits.maxDurationSeconds +
    RECALL_POST_MEETING_GRACE_SECONDS
  );
}

export function getRecallBotPhase(bot: RecallBot): NotetakerBotStateDto["phase"] {
  const latest = latestStatusChange(bot);
  if (!latest || PRE_JOIN_CODES.has(latest.code)) return "STARTING";
  if (latest.code === "in_waiting_room") return "WAITING";
  if (IN_MEETING_CODES.has(latest.code)) return "IN_MEETING";
  return "ENDED";
}

export function findRecallTerminalStatus(
  bot: RecallBot
): { code: "call_ended" | "fatal"; subCode: string | null; at: string } | null {
  for (let i = bot.status_changes.length - 1; i >= 0; i--) {
    const change = bot.status_changes[i];
    if (change.code === "call_ended" || change.code === "fatal") {
      return { code: change.code, subCode: change.sub_code ?? null, at: change.created_at };
    }
  }
  return null;
}

export function isRecallBotDone(bot: RecallBot): boolean {
  return bot.status_changes.some((change) => change.code === "done" || change.code === "fatal");
}

export function mapRecallEndReason(input: {
  code: "call_ended" | "fatal";
  subCode: string | null;
  admitted: boolean;
  stopRequested: boolean;
}): NotetakerBotEndReason {
  const { code, subCode, admitted, stopRequested } = input;
  if (code === "fatal") return (subCode && FATAL_REASONS[subCode]) || "INTERRUPTED";

  if (subCode === "bot_received_leave_call") return stopRequested ? "STOP_REQUESTED" : "INTERRUPTED";
  const mapped = subCode ? CALL_ENDED_REASONS[subCode] : undefined;
  if (mapped) return mapped;
  return admitted ? "MEETING_ENDED" : "INTERRUPTED";
}

export function buildRecallLifecycleEvents(input: {
  sessionId: string;
  bot: RecallBot;
  newEventId?: EventIdFactory;
}): NotetakerBotEvent[] {
  const { sessionId, bot } = input;
  const newEventId = input.newEventId ?? defaultEventId;
  const events: NotetakerBotEvent[] = [];

  const waitingRoom = bot.status_changes.find((change) => change.code === "in_waiting_room");
  if (waitingRoom) {
    events.push({
      eventId: newEventId(),
      sessionId,
      sequence: RECALL_EVENT_SEQUENCE.JOIN_REQUESTED,
      occurredAt: new Date(waitingRoom.created_at).toISOString(),
      type: "session.join_requested",
      data: {},
    });
  }

  const admitted = bot.status_changes.find((change) => ADMITTED_CODES.has(change.code));
  if (admitted) {
    const occurredAt = new Date(admitted.created_at).toISOString();
    events.push(
      {
        eventId: newEventId(),
        sessionId,
        sequence: RECALL_EVENT_SEQUENCE.ADMITTED,
        occurredAt,
        type: "session.admitted",
        data: {},
      },
      {
        eventId: newEventId(),
        sessionId,
        sequence: RECALL_EVENT_SEQUENCE.NOTICE_POSTED,
        occurredAt,
        type: "session.notice_posted",
        data: {},
      }
    );
  }

  return events;
}

function toMs(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

// A single word longer than the passage limit would otherwise make a chunk impossible to fill.
function splitOversizedWord<T extends { text: string }>(word: T): T[] {
  if (word.text.length <= MAX_PASSAGE_TEXT_LENGTH) return [word];
  const pieces: T[] = [];
  for (let i = 0; i < word.text.length; i += MAX_PASSAGE_TEXT_LENGTH) {
    pieces.push({ ...word, text: word.text.slice(i, i + MAX_PASSAGE_TEXT_LENGTH) });
  }
  return pieces;
}

export function buildRecallTranscriptPassages(entries: RecallTranscriptEntry[]): {
  passages: NotetakerBotPassage[];
  speakerNamesAvailable: boolean;
  lastEndMs: number;
} {
  const passages: NotetakerBotPassage[] = [];
  const unknownNumbers = new Map<number, number>();
  let allNamed = true;
  let lastEndMs = 0;

  for (const entry of entries) {
    const words = entry.words
      .map((word) => ({ ...word, text: word.text.trim() }))
      .filter((word) => word.text.length > 0)
      .flatMap(splitOversizedWord);
    if (words.length === 0) continue;

    const name = entry.participant.name?.trim().slice(0, MAX_SPEAKER_NAME_LENGTH) || null;
    let speakerKey: string;
    let unknownSpeakerNumber: number | null = null;
    if (name) {
      speakerKey = `${PARTICIPANT_SPEAKER_KEY_PREFIX}recall-${entry.participant.id}`;
    } else {
      allNamed = false;
      let number = unknownNumbers.get(entry.participant.id);
      if (number === undefined) {
        number = unknownNumbers.size + 1;
        unknownNumbers.set(entry.participant.id, number);
      }
      unknownSpeakerNumber = number;
      speakerKey = `${UNKNOWN_SPEAKER_KEY_PREFIX}${number}`;
    }

    let chunk: typeof words = [];
    let chunkLength = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const startMs = toMs(first.start_timestamp.relative);
      const endMs = Math.max(startMs, toMs((last.end_timestamp ?? last.start_timestamp).relative));
      lastEndMs = Math.max(lastEndMs, endMs);
      passages.push({
        index: passages.length,
        speakerKey,
        speakerName: name,
        unknownSpeakerNumber,
        startMs,
        endMs,
        text: chunk.map((word) => word.text).join(" "),
        language: entry.language_code ?? null,
      });
      chunk = [];
      chunkLength = 0;
    };

    for (const word of words) {
      const addedLength = chunk.length === 0 ? word.text.length : word.text.length + 1;
      if (chunkLength + addedLength > MAX_PASSAGE_TEXT_LENGTH) flush();
      chunkLength += chunk.length === 0 ? word.text.length : word.text.length + 1;
      chunk.push(word);
    }
    flush();
  }

  return { passages, speakerNamesAvailable: passages.length > 0 && allNamed, lastEndMs };
}

export function buildRecallPassageEvents(input: {
  sessionId: string;
  passages: NotetakerBotPassage[];
  occurredAt: string;
  newEventId?: EventIdFactory;
}): NotetakerBotEvent[] {
  const newEventId = input.newEventId ?? defaultEventId;
  const events: NotetakerBotEvent[] = [];
  for (let i = 0; i * MAX_PASSAGES_PER_EVENT < input.passages.length; i++) {
    events.push({
      eventId: newEventId(),
      sessionId: input.sessionId,
      sequence: RECALL_EVENT_SEQUENCE.PASSAGES_BASE + i,
      occurredAt: input.occurredAt,
      type: "transcript.passages",
      data: { passages: input.passages.slice(i * MAX_PASSAGES_PER_EVENT, (i + 1) * MAX_PASSAGES_PER_EVENT) },
    });
  }
  return events;
}

export function buildRecallEndedEvent(input: {
  sessionId: string;
  endReason: NotetakerBotEndReason;
  durationMs: number;
  passageCount: number;
  speakerNamesAvailable?: boolean;
  occurredAt: string;
  newEventId?: EventIdFactory;
}): NotetakerBotEvent {
  const newEventId = input.newEventId ?? defaultEventId;
  return {
    eventId: newEventId(),
    sessionId: input.sessionId,
    sequence: RECALL_EVENT_SEQUENCE.ENDED,
    occurredAt: input.occurredAt,
    type: "session.ended",
    data: {
      endReason: input.endReason,
      durationMs: input.durationMs,
      interruptedAtMs: null,
      passageCount: input.passageCount,
      ...(input.speakerNamesAvailable === undefined
        ? {}
        : { speakerNamesAvailable: input.speakerNamesAvailable }),
    },
  };
}

export function sortRecallRecordingsByStartedAt(recordings: RecallRecording[]): RecallRecording[] {
  return [...recordings].sort((a, b) => {
    const aStart = a.started_at ? Date.parse(a.started_at) : Number.POSITIVE_INFINITY;
    const bStart = b.started_at ? Date.parse(b.started_at) : Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });
}
