import { notetakerBotEventSchema } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it } from "vitest";
import {
  buildRecallEndedEvent,
  buildRecallLifecycleEvents,
  buildRecallPassageEvents,
  buildRecallTranscriptPassages,
  findRecallTerminalStatus,
  getRecallBotPhase,
  getRecallLivenessTimeoutSeconds,
  isRecallBotDone,
  mapRecallEndReason,
  RECALL_EVENT_SEQUENCE,
  RECALL_POST_MEETING_GRACE_SECONDS,
} from "./recallEventTranslation";
import type { RecallBot, RecallTranscriptEntry } from "./recallSchemas";

let counter = 0;
const newEventId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function botWith(...changes: [code: string, at: string, subCode?: string][]): RecallBot {
  return {
    id: "bot-1",
    recordings: [],
    status_changes: changes.map(([code, created_at, sub_code]) => ({ code, created_at, sub_code })),
  };
}

function entry(
  id: number,
  name: string | null,
  words: [string, number, number?][],
  language: string | null = "en"
): RecallTranscriptEntry {
  return {
    participant: { id, name },
    language_code: language,
    words: words.map(([text, start, end]) => ({
      text,
      start_timestamp: { relative: start },
      end_timestamp: end === undefined ? undefined : { relative: end },
    })),
  };
}

describe("getRecallLivenessTimeoutSeconds", () => {
  it("sums every phase of the session plus the post-meeting grace", () => {
    const limits = {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 300,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 7200,
      joinLeadSeconds: 900,
      heartbeatTimeoutSeconds: 180,
      summaryMinWords: 50,
    };
    expect(getRecallLivenessTimeoutSeconds(limits)).toBe(
      900 + 300 + 600 + 7200 + RECALL_POST_MEETING_GRACE_SECONDS
    );
  });
});

describe("getRecallBotPhase", () => {
  it.each([
    [[], "STARTING"],
    [[["ready"]], "STARTING"],
    [[["joining_call"]], "STARTING"],
    [[["joining_call"], ["in_waiting_room"]], "WAITING"],
    [[["in_waiting_room"], ["in_call_not_recording"]], "IN_MEETING"],
    [[["in_call_recording"]], "IN_MEETING"],
    [[["recording_permission_allowed"]], "IN_MEETING"],
    [[["recording_permission_denied"]], "IN_MEETING"],
    [[["in_call_recording"], ["call_ended"]], "ENDED"],
    [[["call_ended"], ["done"]], "ENDED"],
    [[["joining_call"], ["fatal"]], "ENDED"],
  ] as [string[][], string][])("maps %j to %s", (codes, phase) => {
    const bot = botWith(...codes.map(([code]) => [code, "2026-01-01T10:00:00Z"] as [string, string]));
    expect(getRecallBotPhase(bot)).toBe(phase);
  });
});

describe("findRecallTerminalStatus / isRecallBotDone", () => {
  it("returns the latest call_ended or fatal", () => {
    const bot = botWith(
      ["call_ended", "2026-01-01T10:00:00Z", "call_ended_by_host"],
      ["fatal", "2026-01-01T11:00:00Z", "bot_errored"]
    );
    expect(findRecallTerminalStatus(bot)).toEqual({
      code: "fatal",
      subCode: "bot_errored",
      at: "2026-01-01T11:00:00Z",
    });
  });

  it("returns null without a terminal status and defaults a missing sub code to null", () => {
    expect(findRecallTerminalStatus(botWith(["in_call_recording", "2026-01-01T10:00:00Z"]))).toBeNull();
    expect(findRecallTerminalStatus(botWith(["call_ended", "2026-01-01T10:00:00Z"]))?.subCode).toBeNull();
  });

  it("is done after done or fatal only", () => {
    expect(isRecallBotDone(botWith(["call_ended", "2026-01-01T10:00:00Z"]))).toBe(false);
    expect(isRecallBotDone(botWith(["done", "2026-01-01T10:00:00Z"]))).toBe(true);
    expect(isRecallBotDone(botWith(["fatal", "2026-01-01T10:00:00Z"]))).toBe(true);
  });
});

describe("mapRecallEndReason", () => {
  const base = { admitted: true, stopRequested: false };

  it.each([
    ["call_ended_by_host", "MEETING_ENDED"],
    ["call_ended_by_platform_idle", "MEETING_ENDED"],
    ["timeout_exceeded_everyone_left", "ALONE_TIMEOUT"],
    ["timeout_exceeded_silence_detected", "ALONE_TIMEOUT"],
    ["timeout_exceeded_only_bots_detected_using_participant_names", "ALONE_TIMEOUT"],
    ["timeout_exceeded_only_bots_detected_using_participant_events", "ALONE_TIMEOUT"],
    ["call_ended_by_platform_max_length", "LENGTH_LIMIT_REACHED"],
    ["timeout_exceeded_in_call_recording", "LENGTH_LIMIT_REACHED"],
    ["timeout_exceeded_waiting_room", "NOT_ADMITTED"],
    ["call_ended_by_platform_waiting_room_timeout", "NOT_ADMITTED"],
    ["bot_kicked_from_waiting_room", "NOT_ADMITTED"],
    ["timeout_exceeded_noone_joined", "MEETING_DID_NOT_START"],
    ["meeting_not_started", "MEETING_DID_NOT_START"],
    ["bot_kicked_from_call", "REMOVED_BY_PARTICIPANT"],
    ["timeout_exceeded_in_call_not_recording", "INTERRUPTED"],
    ["timeout_exceeded_recording_permission_denied", "INTERRUPTED"],
  ] as const)("maps call_ended/%s to %s regardless of admission", (subCode, expected) => {
    for (const admitted of [true, false]) {
      expect(mapRecallEndReason({ code: "call_ended", subCode, admitted, stopRequested: false })).toBe(
        expected
      );
    }
  });

  it("maps bot_received_leave_call by whether a stop was requested", () => {
    const input = { code: "call_ended", subCode: "bot_received_leave_call", admitted: true } as const;
    expect(mapRecallEndReason({ ...input, stopRequested: true })).toBe("STOP_REQUESTED");
    expect(mapRecallEndReason({ ...input, stopRequested: false })).toBe("INTERRUPTED");
  });

  it("defaults null and unknown call_ended sub codes by admission", () => {
    for (const subCode of [null, "some_future_sub_code"]) {
      expect(mapRecallEndReason({ ...base, code: "call_ended", subCode })).toBe("MEETING_ENDED");
      expect(mapRecallEndReason({ ...base, admitted: false, code: "call_ended", subCode })).toBe(
        "INTERRUPTED"
      );
    }
  });

  it.each([
    ["meeting_not_found", "MEETING_LINK_UNUSABLE"],
    ["meeting_link_invalid", "MEETING_LINK_UNUSABLE"],
    ["meeting_link_expired", "MEETING_LINK_UNUSABLE"],
    ["meeting_requires_registration", "MEETING_LINK_UNUSABLE"],
    ["meeting_requires_sign_in", "MEETING_LINK_UNUSABLE"],
    ["meeting_password_incorrect", "MEETING_LINK_UNUSABLE"],
    ["meeting_not_accessible", "MEETING_LINK_UNUSABLE"],
    ["google_meet_knocking_disabled", "MEETING_LINK_UNUSABLE"],
    ["google_meet_organisation_restricted", "MEETING_LINK_UNUSABLE"],
    ["google_meet_bot_blocked", "MEETING_LINK_UNUSABLE"],
    ["microsoft_teams_sign_in_credentials_missing", "MEETING_LINK_UNUSABLE"],
    ["microsoft_teams_bot_not_invited", "MEETING_LINK_UNUSABLE"],
    ["microsoft_teams_captcha_error", "MEETING_LINK_UNUSABLE"],
    ["microsoft_teams_townhall_meeting_not_supported", "MEETING_LINK_UNUSABLE"],
    ["meeting_not_started", "MEETING_DID_NOT_START"],
    ["meeting_ended", "MEETING_DID_NOT_START"],
    ["microsoft_teams_event_not_started_for_external", "MEETING_DID_NOT_START"],
    ["meeting_locked", "NOT_ADMITTED"],
    ["meeting_full", "NOT_ADMITTED"],
    ["bot_errored", "INTERRUPTED"],
    ["some_future_sub_code", "INTERRUPTED"],
    [null, "INTERRUPTED"],
  ] as const)("maps fatal/%s to %s", (subCode, expected) => {
    for (const admitted of [true, false]) {
      expect(mapRecallEndReason({ code: "fatal", subCode, admitted, stopRequested: false })).toBe(expected);
    }
  });
});

describe("buildRecallLifecycleEvents", () => {
  const sessionId = "session-1";

  it("emits join_requested, admitted and notice_posted for a waiting room join", () => {
    const bot = botWith(
      ["joining_call", "2026-01-01T09:59:00Z"],
      ["in_waiting_room", "2026-01-01T10:00:00Z"],
      ["in_call_not_recording", "2026-01-01T10:01:00Z"],
      ["in_call_recording", "2026-01-01T10:02:00Z"]
    );
    const events = buildRecallLifecycleEvents({ sessionId, bot, newEventId });
    expect(events.map((event) => [event.type, event.sequence, event.occurredAt])).toEqual([
      ["session.join_requested", RECALL_EVENT_SEQUENCE.JOIN_REQUESTED, "2026-01-01T10:00:00.000Z"],
      ["session.admitted", RECALL_EVENT_SEQUENCE.ADMITTED, "2026-01-01T10:01:00.000Z"],
      ["session.notice_posted", RECALL_EVENT_SEQUENCE.NOTICE_POSTED, "2026-01-01T10:01:00.000Z"],
    ]);
    for (const event of events) expect(() => notetakerBotEventSchema.parse(event)).not.toThrow();
  });

  it("skips join_requested for a direct join and counts the first in-call status", () => {
    const bot = botWith(
      ["joining_call", "2026-01-01T09:59:00Z"],
      ["in_call_recording", "2026-01-01T10:00:00Z"],
      ["in_call_recording", "2026-01-01T10:30:00Z"]
    );
    const events = buildRecallLifecycleEvents({ sessionId, bot, newEventId });
    expect(events.map((event) => event.type)).toEqual(["session.admitted", "session.notice_posted"]);
    expect(events[0].occurredAt).toBe("2026-01-01T10:00:00.000Z");
  });

  it("admits on recording_permission_allowed", () => {
    const bot = botWith(["recording_permission_allowed", "2026-01-01T10:00:00Z"]);
    expect(buildRecallLifecycleEvents({ sessionId, bot, newEventId }).map((e) => e.type)).toEqual([
      "session.admitted",
      "session.notice_posted",
    ]);
  });

  it("emits nothing before the bot reached a waiting room or the call", () => {
    const bot = botWith(["joining_call", "2026-01-01T09:59:00Z"]);
    expect(buildRecallLifecycleEvents({ sessionId, bot, newEventId })).toEqual([]);
  });

  it("generates a uuid event id by default", () => {
    const bot = botWith(["in_waiting_room", "2026-01-01T10:00:00Z"]);
    const [event] = buildRecallLifecycleEvents({ sessionId, bot });
    expect(() => notetakerBotEventSchema.parse(event)).not.toThrow();
  });
});

describe("buildRecallTranscriptPassages", () => {
  it("builds named passages with ms timestamps and a participant speaker key", () => {
    const result = buildRecallTranscriptPassages([
      entry(7, "  Ada Lovelace ", [
        ["Hello", 1.2344, 1.5],
        ["world", 1.6, 2.0004],
      ]),
    ]);
    expect(result.passages).toEqual([
      {
        index: 0,
        speakerKey: "participant:recall-7",
        speakerName: "Ada Lovelace",
        unknownSpeakerNumber: null,
        startMs: 1234,
        endMs: 2000,
        text: "Hello world",
        language: "en",
      },
    ]);
    expect(result.speakerNamesAvailable).toBe(true);
    expect(result.lastEndMs).toBe(2000);
  });

  it("numbers unnamed participants by first appearance and reports names unavailable", () => {
    const result = buildRecallTranscriptPassages([
      entry(9, null, [["a", 0, 1]]),
      entry(3, "  ", [["b", 1, 2]]),
      entry(9, null, [["c", 2, 3]], null),
    ]);
    expect(result.passages.map((p) => [p.speakerKey, p.unknownSpeakerNumber, p.speakerName])).toEqual([
      ["unknown:1", 1, null],
      ["unknown:2", 2, null],
      ["unknown:1", 1, null],
    ]);
    expect(result.passages[2].language).toBeNull();
    expect(result.passages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(result.speakerNamesAvailable).toBe(false);
  });

  it("falls back to the start timestamp and never ends before it starts", () => {
    const result = buildRecallTranscriptPassages([
      entry(1, "A", [
        ["x", 5],
        ["y", 6, 4],
      ]),
    ]);
    expect(result.passages[0].startMs).toBe(5000);
    expect(result.passages[0].endMs).toBe(5000);
  });

  it("caps the speaker name at 200 characters", () => {
    const result = buildRecallTranscriptPassages([entry(1, "n".repeat(300), [["x", 0, 1]])]);
    expect(result.passages[0].speakerName).toHaveLength(200);
  });

  it("splits long text at word boundaries using each part's own timestamps", () => {
    const word = "w".repeat(99);
    const words: [string, number, number][] = Array.from({ length: 25 }, (_, i) => [word, i, i + 0.5]);
    const { passages } = buildRecallTranscriptPassages([entry(1, "A", words)]);
    expect(passages).toHaveLength(3);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(1000);
      expect(passage.text.startsWith(word)).toBe(true);
      expect(passage.text.endsWith(word)).toBe(true);
    }
    expect(passages[0].text.split(" ")).toHaveLength(10);
    expect(passages[0].startMs).toBe(0);
    expect(passages[0].endMs).toBe(9500);
    expect(passages[1].startMs).toBe(10_000);
    expect(passages[2].endMs).toBe(24_500);
    for (const passage of passages) expect(passage.speakerKey).toBe("participant:recall-1");
  });

  it("splits a single oversized word", () => {
    const { passages } = buildRecallTranscriptPassages([entry(1, "A", [["x".repeat(2500), 0, 1]])]);
    expect(passages.map((p) => p.text.length)).toEqual([1000, 1000, 500]);
  });

  it("skips empty entries and reports no names for an empty transcript", () => {
    const result = buildRecallTranscriptPassages([entry(1, "A", [[" ", 0, 1]]), entry(2, "B", [])]);
    expect(result).toEqual({ passages: [], speakerNamesAvailable: false, lastEndMs: 0 });
  });
});

describe("buildRecallPassageEvents / buildRecallEndedEvent", () => {
  const sessionId = "session-1";
  const occurredAt = "2026-01-01T11:00:00.000Z";

  it("chunks 120 passages into 50/50/20 events with sequences 1000..1002", () => {
    const entries = Array.from({ length: 120 }, (_, i) =>
      entry(i % 3, i % 3 === 0 ? null : `P${i % 3}`, [["hi", i, i + 1]])
    );
    const { passages } = buildRecallTranscriptPassages(entries);
    const events = buildRecallPassageEvents({ sessionId, passages, occurredAt, newEventId });
    expect(events.map((e) => e.sequence)).toEqual([1000, 1001, 1002]);
    expect(events.map((e) => (e.type === "transcript.passages" ? e.data.passages.length : -1))).toEqual([
      50, 50, 20,
    ]);
    for (const event of events) expect(() => notetakerBotEventSchema.parse(event)).not.toThrow();
  });

  it("emits no passage events for no passages", () => {
    expect(buildRecallPassageEvents({ sessionId, passages: [], occurredAt })).toEqual([]);
  });

  it("builds a valid ended event at the last sequence", () => {
    const event = buildRecallEndedEvent({
      sessionId,
      endReason: "MEETING_ENDED",
      durationMs: 60_000,
      passageCount: 3,
      speakerNamesAvailable: true,
      occurredAt,
      newEventId,
    });
    expect(event.sequence).toBe(1_000_000_000);
    expect(notetakerBotEventSchema.parse(event)).toMatchObject({
      type: "session.ended",
      data: { interruptedAtMs: null, passageCount: 3, speakerNamesAvailable: true },
    });
  });

  it("omits speakerNamesAvailable when not given", () => {
    const event = buildRecallEndedEvent({
      sessionId,
      endReason: "INTERRUPTED",
      durationMs: 0,
      passageCount: 0,
      occurredAt,
    });
    expect(event.type === "session.ended" && "speakerNamesAvailable" in event.data).toBe(false);
    expect(() => notetakerBotEventSchema.parse(event)).not.toThrow();
  });
});
