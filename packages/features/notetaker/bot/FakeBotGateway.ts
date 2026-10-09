import { randomUUID } from "node:crypto";
import type {
  NotetakerBotEvent,
  NotetakerBotJoinRequest,
  NotetakerBotPassage,
  NotetakerBotStateDto,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";
import type { NotetakerFakeScenario } from "../lib/config";
import type { INotetakerBotGateway, NotetakerBotEventSink } from "./INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "./INotetakerBotGateway";

const OFFSET_ADMITTED_MS = 5_000;
const OFFSET_NOTICE_POSTED_MS = 6_000;
const OFFSET_FIRST_PASSAGES_MS = 20_000;
const OFFSET_SECOND_PASSAGES_MS = 40_000;
const OFFSET_RECONNECTING_MS = 50_000;
const OFFSET_ENDED_MS = 60_000;

const PASSAGE_ALEX: NotetakerBotPassage = {
  index: 0,
  speakerKey: "speaker-1",
  speakerName: "Alex Example",
  unknownSpeakerNumber: null,
  startMs: 0,
  endMs: 4000,
  text: "Welcome everyone, let's get started. Today we need to decide when the new booking page goes live.",
  language: "en",
};

const PASSAGE_SAM: NotetakerBotPassage = {
  index: 1,
  speakerKey: "speaker-2",
  speakerName: "Sam Example",
  unknownSpeakerNumber: null,
  startMs: 4500,
  endMs: 9000,
  text: "Thanks Alex, I have an update on the project. Testing is finished, so we agreed to launch on Monday, and I will send the release notes to the team today.",
  language: "en",
};

const PASSAGE_UNKNOWN: NotetakerBotPassage = {
  index: 2,
  speakerKey: "speaker-3",
  speakerName: null,
  unknownSpeakerNumber: 1,
  startMs: 9500,
  endMs: 12000,
  text: "Sounds good to me.",
  language: "en",
};

type SessionRecord = { externalRef: string; lastSequence: number; ended: boolean };

type EventDraft = { offsetMs: number; build: (envelope: EventEnvelope) => NotetakerBotEvent };
type EventEnvelope = { eventId: string; sessionId: string; sequence: number; occurredAt: string };

const joinRequested = (): EventDraft => ({
  offsetMs: 0,
  build: (envelope) => ({ ...envelope, type: "session.join_requested", data: {} }),
});

const admitted = (): EventDraft => ({
  offsetMs: OFFSET_ADMITTED_MS,
  build: (envelope) => ({ ...envelope, type: "session.admitted", data: {} }),
});

const noticePosted = (): EventDraft => ({
  offsetMs: OFFSET_NOTICE_POSTED_MS,
  build: (envelope) => ({ ...envelope, type: "session.notice_posted", data: {} }),
});

const passages = (offsetMs: number, items: NotetakerBotPassage[]): EventDraft => ({
  offsetMs,
  build: (envelope) => ({ ...envelope, type: "transcript.passages", data: { passages: items } }),
});

const reconnecting = (atMs: number): EventDraft => ({
  offsetMs: OFFSET_RECONNECTING_MS,
  build: (envelope) => ({ ...envelope, type: "session.reconnecting", data: { atMs } }),
});

const ended = (data: {
  endReason:
    | "MEETING_ENDED"
    | "NOT_ADMITTED"
    | "MEETING_DID_NOT_START"
    | "REMOVED_BY_PARTICIPANT"
    | "INTERRUPTED"
    | "LENGTH_LIMIT_REACHED";
  durationMs: number;
  interruptedAtMs: number | null;
  passageCount: number;
}): EventDraft => ({
  offsetMs: OFFSET_ENDED_MS,
  build: (envelope) => ({ ...envelope, type: "session.ended", data }),
});

function buildScript(scenario: NotetakerFakeScenario, request: NotetakerBotJoinRequest): EventDraft[] {
  const joined = [joinRequested(), admitted(), noticePosted()];
  const firstPassages = passages(OFFSET_FIRST_PASSAGES_MS, [PASSAGE_ALEX, PASSAGE_SAM]);

  switch (scenario) {
    case "happy":
      return [
        ...joined,
        firstPassages,
        passages(OFFSET_SECOND_PASSAGES_MS, [PASSAGE_UNKNOWN]),
        ended({ endReason: "MEETING_ENDED", durationMs: 12_000, interruptedAtMs: null, passageCount: 3 }),
      ];
    case "not_admitted":
      return [
        joinRequested(),
        ended({ endReason: "NOT_ADMITTED", durationMs: 0, interruptedAtMs: null, passageCount: 0 }),
      ];
    case "meeting_did_not_start":
      return [
        joinRequested(),
        ended({ endReason: "MEETING_DID_NOT_START", durationMs: 0, interruptedAtMs: null, passageCount: 0 }),
      ];
    case "no_speech":
      return [
        ...joined,
        ended({ endReason: "MEETING_ENDED", durationMs: 60_000, interruptedAtMs: null, passageCount: 0 }),
      ];
    case "removed_by_participant":
      return [
        ...joined,
        firstPassages,
        ended({
          endReason: "REMOVED_BY_PARTICIPANT",
          durationMs: 10_000,
          interruptedAtMs: null,
          passageCount: 2,
        }),
      ];
    case "interrupted":
      return [
        ...joined,
        firstPassages,
        reconnecting(9_000),
        ended({ endReason: "INTERRUPTED", durationMs: 10_000, interruptedAtMs: 9_000, passageCount: 2 }),
      ];
    case "length_limit":
      return [
        ...joined,
        firstPassages,
        ended({
          endReason: "LENGTH_LIMIT_REACHED",
          durationMs: request.limits.maxDurationSeconds * 1000,
          interruptedAtMs: null,
          passageCount: 2,
        }),
      ];
    case "link_unusable":
    case "manual":
      return [];
  }
}

/**
 * In-process stand-in for the bot: plays a canned event script through the event sink so the
 * pipeline can be exercised without a real meeting.
 */
export class FakeBotGateway implements INotetakerBotGateway {
  readonly joinRequests: NotetakerBotJoinRequest[] = [];
  readonly stopRequests: { sessionId: string; reason: NotetakerBotStopReason }[] = [];
  readonly scriptErrors: unknown[] = [];

  private readonly scenario: NotetakerFakeScenario;
  private readonly eventSink: NotetakerBotEventSink;
  private readonly sessions = new Map<string, SessionRecord>();
  private lastScript: Promise<void> = Promise.resolve();

  constructor(deps: { scenario: NotetakerFakeScenario; eventSink: NotetakerBotEventSink }) {
    this.scenario = deps.scenario;
    this.eventSink = deps.eventSink;
  }

  async requestJoin(input: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    this.joinRequests.push(input);

    if (this.scenario === "link_unusable") {
      throw createNotetakerBotGatewayError("LINK_UNUSABLE", "Fake bot: meeting link unusable");
    }

    const known = this.sessions.get(input.sessionId);
    if (known) return { externalRef: known.externalRef };

    const record: SessionRecord = {
      externalRef: `fake-ref-${input.sessionId}`,
      lastSequence: 0,
      ended: false,
    };
    this.sessions.set(input.sessionId, record);

    if (this.scenario !== "manual") {
      // The caller stores externalRef only after this method resolves, so events must not start sooner.
      this.lastScript = new Promise<void>((resolve) => {
        setTimeout(() => {
          this.playScript(input, record).then(resolve);
        }, 0);
      });
    }

    return { externalRef: record.externalRef };
  }

  async requestStop(input: { sessionId: string; reason: NotetakerBotStopReason }): Promise<void> {
    this.stopRequests.push({ sessionId: input.sessionId, reason: input.reason });
  }

  async getState(sessionId: string): Promise<NotetakerBotStateDto | null> {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    return {
      sessionId,
      phase: record.ended ? "ENDED" : "STARTING",
      lastEventSequence: record.lastSequence,
    };
  }

  whenIdle(): Promise<void> {
    return this.lastScript;
  }

  private async playScript(request: NotetakerBotJoinRequest, record: SessionRecord): Promise<void> {
    const startMs = Date.parse(request.scheduledStartAt);
    try {
      for (const draft of buildScript(this.scenario, request)) {
        const event = draft.build({
          eventId: randomUUID(),
          sessionId: request.sessionId,
          sequence: record.lastSequence + 1,
          occurredAt: new Date(startMs + draft.offsetMs).toISOString(),
        });
        await this.eventSink(event);
        record.lastSequence = event.sequence;
        if (event.type === "session.ended") record.ended = true;
      }
    } catch (error) {
      this.scriptErrors.push(error);
    }
  }
}
