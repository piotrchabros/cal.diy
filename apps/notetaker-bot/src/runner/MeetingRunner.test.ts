// @vitest-environment node
import fs from "node:fs";
import type {
  NotetakerBotEndReason,
  NotetakerBotJoinRequest,
  NotetakerBotPassage,
} from "@calcom/lib/notetaker/botContract";
import { notetakerBotEventSchema, notetakerBotPassageSchema } from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSenderStopCause, IEventSender, NotetakerBotEventDraft } from "../callback/EventSender";
import type { Logger } from "../logger";
import { createLogger, createSilentLogger } from "../logger";
import { FakePlatformAdapter } from "../platform/FakePlatformAdapter";
import type { PlatformEvent, PlatformHandlers } from "../platform/PlatformAdapter";
import { PlatformLinkUnusableError } from "../platform/PlatformAdapter";
import type { ISpeakerAttributor, SpeakerAttribution } from "../speakers/SpeakerAttribution";
import { FakeSpeechToTextProvider } from "../stt/FakeSpeechToTextProvider";
import type { SttUtterance } from "../stt/SpeechToTextProvider";
import { buildJoinRequest } from "../testing/httpTestKit";
import type { RunnerStatus } from "./launcher/MeetingRunnerLauncher";
import type { RunnerEndSummary } from "./MeetingRunner";
import {
  ENDED_DELIVERY_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LEAVE_TIMEOUT_MS,
  MeetingRunner,
  NOTICE_DEADLINE_MS,
  NOTICE_RETRY_INTERVAL_MS,
  PASSAGE_FLUSH_INTERVAL_MS,
  REJOIN_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STT_FLUSH_TIMEOUT_MS,
} from "./MeetingRunner";
import { MAX_PASSAGE_DURATION_MS, MAX_PASSAGE_TEXT_LENGTH } from "./PassageBuilder";

type DraftOf<T extends NotetakerBotEventDraft["type"]> = Extract<NotetakerBotEventDraft, { type: T }>;
type EndedData = DraftOf<"session.ended">["data"];

class RecordingEventSender implements IEventSender {
  readonly drafts: NotetakerBotEventDraft[] = [];
  readonly flushCalls: (number | undefined)[] = [];
  stopCalls = 0;
  lastAcceptedSequence = 0;
  pendingCount = 0;
  isStopped = false;
  // While true, enqueued events stay pending until deliverAll(), like a callback that is down.
  holdDelivery = false;
  flushGate: Promise<void> = Promise.resolve();

  enqueue(draft: NotetakerBotEventDraft): void {
    this.drafts.push(draft);
    if (this.holdDelivery) {
      this.pendingCount += 1;
      return;
    }
    this.lastAcceptedSequence = this.drafts.length;
  }

  deliverAll(): void {
    this.pendingCount = 0;
    this.lastAcceptedSequence = this.drafts.length;
  }

  flush(timeoutMs?: number): Promise<void> {
    this.flushCalls.push(timeoutMs);
    return this.flushGate;
  }

  stop(): void {
    this.stopCalls += 1;
    this.isStopped = true;
    this.pendingCount = 0;
  }
}

class StubSpeakerAttributor implements ISpeakerAttributor {
  readonly speakerSamples: { atMs: number; participantId: string; name: string; speaking: boolean }[] = [];
  readonly activitySamples: { atMs: number; sourceKey: string; level: number }[] = [];
  readonly identities: { sourceKey: string; participantId: string; name: string }[] = [];
  readonly attributeCalls: { startMs: number; endMs: number; diarizationLabel: string | null }[] = [];
  next: SpeakerAttribution = {
    speakerKey: "participant:p1",
    speakerName: "Example Person",
    unknownSpeakerNumber: null,
  };

  recordSpeaker(sample: { atMs: number; participantId: string; name: string; speaking: boolean }): void {
    this.speakerSamples.push(sample);
  }

  recordSourceActivity(sample: { atMs: number; sourceKey: string; level: number }): void {
    this.activitySamples.push(sample);
  }

  recordSourceIdentity(identity: { sourceKey: string; participantId: string; name: string }): void {
    this.identities.push(identity);
  }

  attribute(utterance: {
    startMs: number;
    endMs: number;
    diarizationLabel: string | null;
  }): SpeakerAttribution {
    this.attributeCalls.push({ ...utterance });
    return this.next;
  }
}

const UNKNOWN: SpeakerAttribution = { speakerKey: "unknown:1", speakerName: null, unknownSpeakerNumber: 1 };

const NOTICE = buildJoinRequest().noticeMessage;
const FIVE_SECONDS = 5000;

const sendersUnderTest: RecordingEventSender[] = [];

type SetupOptions = {
  request?: Partial<NotetakerBotJoinRequest>;
  platform?: ConstructorParameters<typeof FakePlatformAdapter>[0];
  stt?: ConstructorParameters<typeof FakeSpeechToTextProvider>[0];
  now?: () => number;
  logger?: Logger;
  throwingListener?: boolean;
};

function setup(options: SetupOptions = {}) {
  const request = buildJoinRequest(options.request);
  const platform = new FakePlatformAdapter(options.platform);
  const stt = new FakeSpeechToTextProvider(options.stt);
  const sender = new RecordingEventSender();
  const attributor = new StubSpeakerAttributor();
  sendersUnderTest.push(sender);

  const joinSpy = vi.spyOn(platform, "join");
  const postSpy = vi.spyOn(platform, "postChatMessage");
  const runner = new MeetingRunner({
    request,
    platform,
    stt,
    attributor,
    sender,
    logger: options.logger ?? createSilentLogger(),
    now: options.now,
  });

  const statuses: RunnerStatus[] = [];
  if (options.throwingListener) {
    runner.onStatusChange(() => {
      throw new Error("listener failed");
    });
  }
  runner.onStatusChange((status) => statuses.push(status));

  let summary: RunnerEndSummary | null = null;
  void runner.done.then((value) => {
    summary = value;
  });

  const handlers = (): PlatformHandlers => {
    const joinHandlers = joinSpy.mock.calls[0]?.[1];
    if (!joinHandlers) throw new Error("platform.join was not called");
    return joinHandlers;
  };

  return {
    runner,
    platform,
    stt,
    sender,
    attributor,
    request,
    statuses,
    postSpy,
    getSummary: () => summary,
    handlers,
  };
}

type Ctx = ReturnType<typeof setup>;

const settle = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function limitsFor(overrides: Partial<NotetakerBotJoinRequest["limits"]>): Partial<NotetakerBotJoinRequest> {
  return { limits: { ...buildJoinRequest().limits, ...overrides } };
}

// Admission happens at +0 ms from start, so the transcript clock equals the ms since start.
async function startAndAdmit(ctx: Ctx, options: { others?: boolean } = {}): Promise<void> {
  ctx.runner.start();
  await settle();
  ctx.platform.emit({ type: "admitted" });
  if (options.others ?? true) ctx.platform.emit({ type: "participant_count", count: 2 });
  await settle();
}

function utterance(startMs: number, endMs: number, text = "hello there", label = "S1"): SttUtterance {
  return { startMs, endMs, text, language: "en", diarizationLabel: label };
}

function draftsOf<T extends NotetakerBotEventDraft["type"]>(
  sender: RecordingEventSender,
  type: T
): DraftOf<T>[] {
  return sender.drafts.filter((draft): draft is DraftOf<T> => draft.type === type);
}

function types(sender: RecordingEventSender): string[] {
  return sender.drafts.map((draft) => draft.type);
}

function endedCount(sender: RecordingEventSender): number {
  return draftsOf(sender, "session.ended").length;
}

function ended(sender: RecordingEventSender): EndedData {
  const list = draftsOf(sender, "session.ended");
  expect(list).toHaveLength(1);
  expect(sender.drafts[sender.drafts.length - 1]?.type).toBe("session.ended");
  const first = list[0];
  if (!first) throw new Error("no session.ended draft");
  return first.data;
}

function allPassages(sender: RecordingEventSender): NotetakerBotPassage[] {
  return draftsOf(sender, "transcript.passages").flatMap((draft) => draft.data.passages);
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function containsBinary(value: unknown): boolean {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (Array.isArray(value)) return value.some(containsBinary);
  if (typeof value === "object" && value !== null) return Object.values(value).some(containsBinary);
  return false;
}

function expectWireValid(drafts: NotetakerBotEventDraft[]): void {
  drafts.forEach((draft, index) => {
    if (draft.type === "transcript.passages") {
      // The sender splits above 50 passages, so only the passages themselves are checked here.
      for (const passage of draft.data.passages) {
        expect(notetakerBotPassageSchema.safeParse(passage).success).toBe(true);
      }
      return;
    }
    const parsed = notetakerBotEventSchema.safeParse({
      eventId: "00000000-0000-4000-8000-000000000000",
      sessionId: "s",
      sequence: index + 1,
      occurredAt: "2030-01-01T00:00:00.000Z",
      ...draft,
    });
    expect(parsed.success).toBe(true);
  });
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function words(count: number): string {
  return Array.from({ length: count }, () => "aaaa").join(" ");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T09:59:00.000Z"));
});

afterEach(() => {
  for (const sender of sendersUnderTest.splice(0)) expectWireValid(sender.drafts);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notice gate", () => {
  it("sends held passages in order once a late notice is posted", async () => {
    const t = setup({ platform: { postChatError: new Error("chat closed") } });
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(100, 500, "first"));
    await advance(5000);
    t.stt.emitUtterance(utterance(6000, 6500, "second"));
    await advance(6000);
    t.platform.setPostChatError(null);

    await advance(2999);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);

    await advance(1);
    expect(types(t.sender).slice(-2)).toEqual(["session.notice_posted", "transcript.passages"]);
    const passagesDrafts = draftsOf(t.sender, "transcript.passages");
    expect(passagesDrafts).toHaveLength(1);
    expect(passagesDrafts[0]?.data.passages.map((passage) => passage.index)).toEqual([0, 1]);
    expect(t.postSpy).toHaveBeenCalledTimes(4);
    expect(t.platform.chatMessages).toEqual([NOTICE]);
  });

  it("holds passages past the 5 s flush and the 50-passage threshold while the notice is pending", async () => {
    const t = setup({ platform: { postChatError: new Error("chat closed") } });
    await startAndAdmit(t);

    for (const i of range(60)) t.stt.emitUtterance(utterance(i * 100, i * 100 + 50, `word${i}`));
    await advance(20000);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);

    t.platform.setPostChatError(null);
    await advance(5000);

    expect(types(t.sender).slice(-2)).toEqual(["session.notice_posted", "transcript.passages"]);
    const passagesDrafts = draftsOf(t.sender, "transcript.passages");
    expect(passagesDrafts).toHaveLength(1);
    expect(passagesDrafts[0]?.data.passages.map((passage) => passage.index)).toEqual(range(60));

    t.platform.emit({ type: "meeting_ended" });
    await settle();
    expect(ended(t.sender).passageCount).toBe(60);
  });

  it("never sends passages, leaves and ends INTERRUPTED when the notice cannot be posted within 30 s", async () => {
    const t = setup({
      platform: { postChatError: new Error("chat closed") },
      stt: { utterancesOnClose: [utterance(25000, 26000, "late words")] },
    });
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(1000, 1500, "early words"));
    await advance(19000);
    t.stt.emitUtterance(utterance(20000, 20500, "more words"));

    await advance(NOTICE_DEADLINE_MS - 20000 - 1);
    expect(endedCount(t.sender)).toBe(0);
    expect(t.platform.leaveCalls).toBe(0);

    await advance(1);
    expect(t.platform.leaveCalls).toBe(1);
    expect(t.postSpy.mock.calls).toEqual(Array.from({ length: 6 }, () => [NOTICE]));
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);
    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 30000,
      interruptedAtMs: 0,
      passageCount: 0,
    });
    expect(t.getSummary()).toEqual({ endReason: "INTERRUPTED", passageCount: 0 });
    expect(t.platform.reconnectCalls).toBe(0);
  });

  it("ends at the deadline even when the post never settles", async () => {
    const t = setup();
    t.postSpy.mockImplementation(() => new Promise<void>(() => {}));
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(1000, 1500, "early words"));
    await advance(NOTICE_DEADLINE_MS - 1000 - 1);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(t.platform.leaveCalls).toBe(1);
    expect(t.postSpy).toHaveBeenCalledTimes(1);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);
    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 30000,
      interruptedAtMs: 0,
      passageCount: 0,
    });
    expect(t.getSummary()).toEqual({ endReason: "INTERRUPTED", passageCount: 0 });
  });

  it("discards held passages when the session is stopped before the notice was posted", async () => {
    const t = setup({ platform: { postChatError: new Error("chat closed") } });
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(1000, 1500, "held words"));
    await advance(9000);
    t.runner.requestStop();
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "STOP_REQUESTED",
      durationMs: 10000,
      interruptedAtMs: null,
      passageCount: 0,
    });
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);
  });

  const endingEvents: { event: PlatformEvent; endReason: NotetakerBotEndReason }[] = [
    { event: { type: "removed" }, endReason: "REMOVED_BY_PARTICIPANT" },
    { event: { type: "meeting_ended" }, endReason: "MEETING_ENDED" },
  ];

  it.each(endingEvents)("discards held passages on $event.type before the notice was posted", async ({
    event,
    endReason,
  }) => {
    const t = setup({
      platform: { postChatError: new Error("chat closed") },
      stt: { utterancesOnClose: [utterance(9000, 9500, "closing words")] },
    });
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(1000, 1500, "held words"));
    await advance(9000);
    t.platform.emit(event);
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason,
      durationMs: 10000,
      interruptedAtMs: null,
      passageCount: 0,
    });
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);
  });

  it("ignores a notice post that resolves after the end began", async () => {
    const t = setup();
    const gate = createDeferred();
    t.postSpy.mockImplementation(() => gate.promise);
    await startAndAdmit(t);

    t.stt.emitUtterance(utterance(0, 500, "held words"));
    t.runner.requestStop();
    gate.resolve();
    await advance(10000);

    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(0);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(ended(t.sender).passageCount).toBe(0);
  });

  it("posts the notice exactly once and reports it", async () => {
    const t = setup();
    await startAndAdmit(t);

    expect(types(t.sender)).toEqual(["session.join_requested", "session.admitted", "session.notice_posted"]);
    expect(t.platform.chatMessages).toEqual([NOTICE]);

    await advance(120000);
    expect(t.postSpy).toHaveBeenCalledTimes(1);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(1);
  });

  it("does not post the notice again after a rejoin or a repeated admitted event", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.platform.emit({ type: "connection_lost" });
    await settle();
    t.platform.emit({ type: "admitted" });
    await advance(60000);

    expect(t.platform.chatMessages).toHaveLength(1);
    expect(draftsOf(t.sender, "session.admitted")).toHaveLength(1);
    expect(draftsOf(t.sender, "session.notice_posted")).toHaveLength(1);
  });
});

describe("joining and admission", () => {
  it("joins once under the display name and sends session.join_requested", async () => {
    const t = setup();
    t.runner.start();
    await settle();

    expect(t.platform.joinCalls).toEqual([
      { meetingUrl: t.request.meetingUrl, displayName: t.request.displayName },
    ]);
    expect(types(t.sender)).toEqual(["session.join_requested"]);
    expect(t.runner.getStatus().phase).toBe("WAITING");

    t.runner.start();
    await settle();
    expect(t.platform.joinCalls).toHaveLength(1);
  });

  it("start returns at once and never throws when join rejects", async () => {
    const t = setup({ platform: { joinError: new Error("boom") } });

    expect(() => t.runner.start()).not.toThrow();
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
    expect(types(t.sender)).toEqual(["session.ended"]);
    expect(t.platform.leaveCalls).toBe(1);
  });

  it("ends MEETING_LINK_UNUSABLE when the link cannot be used", async () => {
    const t = setup({ platform: { joinError: new PlatformLinkUnusableError("bad link") } });

    t.runner.start();
    await settle();

    expect(types(t.sender)).toEqual(["session.ended"]);
    expect(ended(t.sender)).toEqual({
      endReason: "MEETING_LINK_UNUSABLE",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("sends join_requested before admitted when the platform admits during join", async () => {
    const t: Ctx = setup({ platform: { onJoined: () => t.platform.emit({ type: "admitted" }) } });

    t.runner.start();
    await settle();

    expect(types(t.sender).slice(0, 2)).toEqual(["session.join_requested", "session.admitted"]);
  });

  it("ends NOT_ADMITTED after limits.admissionTimeoutSeconds", async () => {
    const t = setup();
    t.runner.start();

    await advance(599999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "NOT_ADMITTED",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("ends NOT_ADMITTED when entry is denied", async () => {
    const t = setup();
    t.runner.start();
    await settle();

    t.platform.emit({ type: "denied" });
    await settle();

    expect(ended(t.sender).endReason).toBe("NOT_ADMITTED");
  });

  it("ignores denied after admission", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.platform.emit({ type: "denied" });
    await advance(10000);

    expect(endedCount(t.sender)).toBe(0);
  });

  it("admission moves to IN_MEETING, starts the provider and sends session.admitted", async () => {
    const t = setup();
    expect(t.stt.started).toBe(false);

    await startAndAdmit(t);

    expect(t.stt.started).toBe(true);
    expect(t.runner.getStatus().phase).toBe("IN_MEETING");
    expect(draftsOf(t.sender, "session.admitted")).toHaveLength(1);
  });
});

describe("limits", () => {
  it("ends MEETING_DID_NOT_START when nobody else joined by the no-show deadline", async () => {
    const t = setup({ request: limitsFor({ admissionTimeoutSeconds: 6000, noShowTimeoutSeconds: 900 }) });
    t.runner.start();

    await advance(959999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "MEETING_DID_NOT_START",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("applies the no-show deadline after admission when the bot stayed alone", async () => {
    const t = setup();
    await startAndAdmit(t, { others: false });
    t.platform.emit({ type: "participant_count", count: 1 });

    await advance(959999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    const data = ended(t.sender);
    expect(data.endReason).toBe("MEETING_DID_NOT_START");
    expect(data.durationMs).toBe(960000);
  });

  it("does not end at the no-show deadline once somebody else was seen", async () => {
    const t = setup();
    await startAndAdmit(t);

    await advance(960000);

    expect(endedCount(t.sender)).toBe(0);
  });

  it("a runner started after the no-show deadline waits a full no-show period from its own start", async () => {
    vi.setSystemTime(new Date("2030-01-01T10:20:00.000Z"));
    const t = setup({ request: limitsFor({ admissionTimeoutSeconds: 6000, noShowTimeoutSeconds: 900 }) });

    t.runner.start();
    await settle();
    expect(endedCount(t.sender)).toBe(0);

    await advance(899999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "MEETING_DID_NOT_START",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("a runner started after the no-show deadline is admitted and transcribes when somebody is present", async () => {
    vi.setSystemTime(new Date("2030-01-01T10:20:00.000Z"));
    const t = setup();
    await startAndAdmit(t);

    expect(endedCount(t.sender)).toBe(0);
    expect(t.stt.started).toBe(true);
    expect(t.runner.getStatus().phase).toBe("IN_MEETING");
    expect(draftsOf(t.sender, "session.admitted")).toHaveLength(1);

    await advance(1000);
    t.stt.emitUtterance(utterance(0, 900, "hello"));
    await advance(PASSAGE_FLUSH_INTERVAL_MS);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(1);

    await advance(900000);
    expect(endedCount(t.sender)).toBe(0);
  });

  it("uses the injected clock", async () => {
    const t = setup({
      request: limitsFor({ admissionTimeoutSeconds: 6000 }),
      now: () => Date.now() - 60_000,
    });
    t.runner.start();

    await advance(1019999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender).endReason).toBe("MEETING_DID_NOT_START");
  });

  it("ends ALONE_TIMEOUT after limits.aloneTimeoutSeconds alone", async () => {
    const t = setup({ request: limitsFor({ aloneTimeoutSeconds: 120 }) });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "participant_count", count: 1 });

    await advance(119999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "ALONE_TIMEOUT",
      durationMs: 130000,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("disarms the alone timer when somebody returns", async () => {
    const t = setup({ request: limitsFor({ aloneTimeoutSeconds: 120 }) });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "participant_count", count: 1 });
    await advance(60000);
    t.platform.emit({ type: "participant_count", count: 2 });
    await advance(330000);
    expect(endedCount(t.sender)).toBe(0);

    t.platform.emit({ type: "participant_count", count: 1 });
    await advance(119999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender).endReason).toBe("ALONE_TIMEOUT");
    expect(ended(t.sender).durationMs).toBe(520000);
  });

  it("does not restart the alone timer on a repeated count", async () => {
    const t = setup({ request: limitsFor({ aloneTimeoutSeconds: 120 }) });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "participant_count", count: 1 });
    await advance(60000);
    t.platform.emit({ type: "participant_count", count: 1 });

    await advance(59999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender).endReason).toBe("ALONE_TIMEOUT");
    expect(ended(t.sender).durationMs).toBe(130000);
  });

  it("does not arm the alone timer before anybody else was seen", async () => {
    const t = setup({ request: limitsFor({ aloneTimeoutSeconds: 120, noShowTimeoutSeconds: 6000 }) });
    await startAndAdmit(t, { others: false });
    t.platform.emit({ type: "participant_count", count: 1 });

    await advance(300000);

    expect(endedCount(t.sender)).toBe(0);
  });

  it("ends LENGTH_LIMIT_REACHED after limits.maxDurationSeconds of meeting time", async () => {
    const t = setup({ request: limitsFor({ maxDurationSeconds: 3600, noShowTimeoutSeconds: 100000 }) });
    await startAndAdmit(t);

    await advance(3599999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "LENGTH_LIMIT_REACHED",
      durationMs: 3600000,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });
});

describe("heartbeat", () => {
  it("sends a heartbeat every 30 s with the participant count", async () => {
    const t = setup();
    t.runner.start();

    await advance(HEARTBEAT_INTERVAL_MS - 1);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(0);

    await advance(1);
    expect(draftsOf(t.sender, "session.heartbeat").map((draft) => draft.data.participantCount)).toEqual([0]);

    t.platform.emit({ type: "admitted" });
    t.platform.emit({ type: "participant_count", count: 3 });
    await advance(HEARTBEAT_INTERVAL_MS);

    expect(draftsOf(t.sender, "session.heartbeat").map((draft) => draft.data.participantCount)).toEqual([
      0, 3,
    ]);
  });

  it("skips a heartbeat while the previous one is unsent", async () => {
    const t = setup();
    t.sender.holdDelivery = true;
    t.runner.start();

    await advance(30000);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(1);
    await advance(30000);
    await advance(30000);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(1);

    t.sender.deliverAll();
    await advance(30000);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(2);
  });

  it("does not skip a heartbeat because a later event is pending", async () => {
    const t = setup();
    t.sender.holdDelivery = true;
    t.runner.start();

    await advance(30000);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(1);
    t.sender.deliverAll();

    await advance(29000);
    t.platform.emit({ type: "admitted" });
    t.platform.emit({ type: "participant_count", count: 2 });
    await settle();
    expect(t.sender.pendingCount).toBeGreaterThan(0);

    await advance(1000);
    expect(draftsOf(t.sender, "session.heartbeat")).toHaveLength(2);
  });

  it("sends no heartbeat after the end", async () => {
    const t = setup();
    await startAndAdmit(t);
    t.platform.emit({ type: "meeting_ended" });
    await settle();
    const count = t.sender.drafts.length;

    await advance(600000);

    expect(t.sender.drafts).toHaveLength(count);
  });
});

describe("ending", () => {
  it("ends MEETING_ENDED with durationMs and passageCount, exactly once and last", async () => {
    const t = setup();
    await startAndAdmit(t);

    await advance(41000);
    t.stt.emitUtterance(utterance(0, 10000, "first words"));
    t.stt.emitUtterance(utterance(10000, 20000, "second words"));
    t.stt.emitUtterance(utterance(30000, 40000, "third words"));
    await advance(1000);
    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(types(t.sender).slice(-2)).toEqual(["transcript.passages", "session.ended"]);
    expect(ended(t.sender)).toEqual({
      endReason: "MEETING_ENDED",
      durationMs: 42000,
      interruptedAtMs: null,
      passageCount: 3,
    });
    expect(t.sender.flushCalls).toEqual([ENDED_DELIVERY_TIMEOUT_MS]);
    expect(t.getSummary()).toEqual({ endReason: "MEETING_ENDED", passageCount: 3 });

    const count = t.sender.drafts.length;
    await advance(600000);
    expect(t.sender.drafts).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves at once and queues session.ended within 5 s of a removal, and never rejoins", async () => {
    const t = setup({ platform: { leaveDelayMs: 60000 }, stt: { closeDelayMs: 60000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "removed" });
    expect(t.platform.leaveCalls).toBe(1);

    await advance(LEAVE_TIMEOUT_MS - 1);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "REMOVED_BY_PARTICIPANT",
      durationMs: 10000,
      interruptedAtMs: null,
      passageCount: 0,
    });

    t.handlers().onEvent({ type: "connection_lost" });
    await advance(600000);
    expect(t.platform.reconnectCalls).toBe(0);
    expect(t.platform.joinCalls).toHaveLength(1);
    expect(endedCount(t.sender)).toBe(1);
  });

  it("ends REMOVED_BY_PARTICIPANT before admission", async () => {
    const t = setup();
    t.runner.start();
    await settle();

    t.platform.emit({ type: "removed" });
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "REMOVED_BY_PARTICIPANT",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("leaves within 5 s of a stop request and never rejoins", async () => {
    const t = setup({ platform: { leaveDelayMs: 60000 }, stt: { closeDelayMs: 60000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.runner.requestStop();
    expect(t.platform.leaveCalls).toBe(1);

    await advance(LEAVE_TIMEOUT_MS - 1);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "STOP_REQUESTED",
      durationMs: 10000,
      interruptedAtMs: null,
      passageCount: 0,
    });

    t.handlers().onEvent({ type: "connection_lost" });
    await advance(600000);
    expect(t.platform.reconnectCalls).toBe(0);
    expect(t.platform.joinCalls).toHaveLength(1);
    expect(endedCount(t.sender)).toBe(1);
  });

  it("requestStop is idempotent and works before start", async () => {
    const t = setup();
    await startAndAdmit(t);
    t.runner.requestStop();
    t.runner.requestStop();
    await settle();

    expect(t.platform.leaveCalls).toBe(1);
    expect(ended(t.sender).endReason).toBe("STOP_REQUESTED");

    const before = setup();
    before.runner.requestStop();
    await settle();
    expect(ended(before.sender).endReason).toBe("STOP_REQUESTED");

    before.runner.start();
    await settle();
    expect(before.platform.joinCalls).toHaveLength(0);
  });

  it("waits for the provider to flush and sends its last utterances before session.ended", async () => {
    const t = setup({ stt: { utterancesOnClose: [utterance(0, 1000, "last words")], closeDelayMs: 2000 } });
    await startAndAdmit(t);

    t.platform.emit({ type: "meeting_ended" });
    await advance(1999);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(types(t.sender).slice(-2)).toEqual(["transcript.passages", "session.ended"]);
    expect(ended(t.sender).passageCount).toBe(1);
  });

  it("gives up on a slow provider after 3 s and ignores what it emits later", async () => {
    const t = setup({ stt: { utterancesOnClose: [utterance(0, 1000, "late words")], closeDelayMs: 5000 } });
    await startAndAdmit(t);

    t.platform.emit({ type: "meeting_ended" });
    await advance(STT_FLUSH_TIMEOUT_MS - 1);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender).passageCount).toBe(0);

    const count = t.sender.drafts.length;
    await advance(2000);
    expect(t.sender.drafts).toHaveLength(count);
  });

  it("ignores every trigger after the end began", async () => {
    const t = setup();
    await startAndAdmit(t);
    t.platform.emit({ type: "meeting_ended" });
    await settle();
    const receivedAudioMs = t.stt.receivedAudioMs;

    t.runner.requestStop();
    t.handlers().onEvent({ type: "removed" });
    t.handlers().onAudioFrame({ samples: new Int16Array(1600) });
    await settle();

    expect(ended(t.sender).endReason).toBe("MEETING_ENDED");
    expect(t.stt.receivedAudioMs).toBe(receivedAudioMs);
  });

  it("stays out of ENDED until session.ended was flushed", async () => {
    const t = setup();
    const gate = createDeferred();
    t.sender.flushGate = gate.promise;
    await startAndAdmit(t);

    t.platform.emit({ type: "meeting_ended" });
    await advance(10000);
    expect(t.getSummary()).toBeNull();
    expect(t.runner.getStatus().phase).toBe("IN_MEETING");

    gate.resolve();
    await settle();
    expect(t.runner.getStatus().phase).toBe("ENDED");
    expect(t.getSummary()).toEqual({ endReason: "MEETING_ENDED", passageCount: 0 });
  });

  it("done resolves and never rejects when leave fails", async () => {
    const t = setup();
    vi.spyOn(t.platform, "leave").mockRejectedValue(new Error("x"));
    await startAndAdmit(t);

    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(ended(t.sender).endReason).toBe("MEETING_ENDED");
    expect(t.getSummary()).toEqual({ endReason: "MEETING_ENDED", passageCount: 0 });
  });
});

describe("connection loss", () => {
  it("sends session.reconnecting once with atMs and continues after a successful rejoin", async () => {
    const t = setup({ platform: { reconnectDelayMs: 2000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    expect(t.platform.reconnectCalls).toBe(1);
    await settle();
    expect(draftsOf(t.sender, "session.reconnecting").map((draft) => draft.data)).toEqual([{ atMs: 10000 }]);

    await advance(10000);
    expect(endedCount(t.sender)).toBe(0);

    await advance(10000);
    t.platform.emit({ type: "meeting_ended" });
    await settle();
    expect(ended(t.sender)).toEqual({
      endReason: "MEETING_ENDED",
      durationMs: 30000,
      interruptedAtMs: null,
      passageCount: 0,
    });
  });

  it("ends INTERRUPTED with interruptedAtMs when the rejoin fails", async () => {
    const t = setup({ platform: { reconnectResult: false } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 10000,
      interruptedAtMs: 10000,
      passageCount: 0,
    });
  });

  it("ends INTERRUPTED when the rejoin takes longer than 60 s", async () => {
    const t = setup({ platform: { reconnectDelayMs: 120000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });

    await advance(REJOIN_TIMEOUT_MS - 1);
    expect(endedCount(t.sender)).toBe(0);

    await advance(1);
    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 10000,
      interruptedAtMs: 10000,
      passageCount: 0,
    });
  });

  it("makes no second attempt and sends no second event on a second loss", async () => {
    const t = setup();
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 20000,
      interruptedAtMs: 20000,
      passageCount: 0,
    });
    expect(t.platform.reconnectCalls).toBe(1);
    expect(draftsOf(t.sender, "session.reconnecting")).toHaveLength(1);
  });

  it("ignores a repeated loss while the rejoin is pending", async () => {
    const t = setup({ platform: { reconnectDelayMs: 5000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    await advance(1000);
    t.platform.emit({ type: "connection_lost" });
    await advance(9000);

    expect(t.platform.reconnectCalls).toBe(1);
    expect(endedCount(t.sender)).toBe(0);
  });

  it("ends INTERRUPTED without a rejoin when the connection is lost before admission", async () => {
    const t = setup();
    t.runner.start();
    await settle();

    t.platform.emit({ type: "connection_lost" });
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 0,
      interruptedAtMs: null,
      passageCount: 0,
    });
    expect(t.platform.reconnectCalls).toBe(0);
    expect(draftsOf(t.sender, "session.reconnecting")).toHaveLength(0);
  });

  it("a stop during the rejoin ends STOP_REQUESTED", async () => {
    const t = setup({ platform: { reconnectDelayMs: 30000 } });
    await startAndAdmit(t);

    await advance(10000);
    t.platform.emit({ type: "connection_lost" });
    t.runner.requestStop();
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "STOP_REQUESTED",
      durationMs: 10000,
      interruptedAtMs: null,
      passageCount: 0,
    });

    await advance(120000);
    expect(endedCount(t.sender)).toBe(1);
  });

  it("positions are integers", async () => {
    let skew = 0;
    const t = setup({ now: () => Date.now() + skew });
    await startAndAdmit(t);

    skew = 0.4;
    await advance(1000);
    t.platform.emit({ type: "speaker", participantId: "p1", name: "Example Person", speaking: true });
    t.platform.emit({ type: "connection_lost" });
    await settle();

    expect(t.attributor.speakerSamples).toHaveLength(1);
    expect(Number.isInteger(t.attributor.speakerSamples[0]?.atMs)).toBe(true);
    const reconnecting = draftsOf(t.sender, "session.reconnecting");
    expect(reconnecting).toHaveLength(1);
    expect(Number.isInteger(reconnecting[0]?.data.atMs)).toBe(true);
  });
});

describe("sender stopped", () => {
  const causes: EventSenderStopCause[] = ["GONE", "UNAUTHORIZED"];

  it.each(causes)("leaves at once and sends nothing more after %s", async (cause) => {
    const t = setup();
    await startAndAdmit(t);
    t.stt.emitUtterance(utterance(0, 500, "waiting words"));

    t.runner.handleSenderStopped(cause);
    expect(t.platform.leaveCalls).toBe(1);
    await settle();

    expect(t.runner.getStatus().phase).toBe("ENDED");
    expect(t.getSummary()).toEqual({ endReason: null, passageCount: 0 });
    expect(endedCount(t.sender)).toBe(0);
    expect(t.stt.closed).toBe(true);
    expect(t.sender.flushCalls).toEqual([]);
    expect(t.sender.stopCalls).toBe(0);

    const count = t.sender.drafts.length;
    await advance(600000);
    expect(t.sender.drafts).toHaveLength(count);
    expect(t.platform.reconnectCalls).toBe(0);
  });

  it.each(causes)("works before admission after %s", async (cause) => {
    const t = setup();
    t.runner.start();
    await settle();

    t.runner.handleSenderStopped(cause);
    expect(t.platform.leaveCalls).toBe(1);
    await settle();

    expect(t.runner.getStatus().phase).toBe("ENDED");
    expect(t.getSummary()).toEqual({ endReason: null, passageCount: 0 });
    expect(endedCount(t.sender)).toBe(0);
    expect(t.stt.closed).toBe(true);
    expect(t.sender.flushCalls).toEqual([]);
    expect(t.sender.stopCalls).toBe(0);

    const count = t.sender.drafts.length;
    await advance(600000);
    expect(t.sender.drafts).toHaveLength(count);
    expect(t.platform.reconnectCalls).toBe(0);
  });

  it("a sender stop during an ending suppresses session.ended", async () => {
    const t = setup({ platform: { leaveDelayMs: 2000 } });
    await startAndAdmit(t);

    t.runner.requestStop();
    await advance(1000);
    t.runner.handleSenderStopped("GONE");
    await advance(10000);

    expect(endedCount(t.sender)).toBe(0);
    expect(t.getSummary()?.endReason).toBeNull();
  });

  it("is idempotent and ignores later triggers", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.runner.handleSenderStopped("GONE");
    t.runner.handleSenderStopped("GONE");
    t.runner.requestStop();
    await settle();
    const count = t.sender.drafts.length;
    await advance(10000);

    expect(t.platform.leaveCalls).toBe(1);
    expect(t.sender.drafts).toHaveLength(count);
  });
});

describe("transcript", () => {
  it("enqueues waiting passages every 5 s", async () => {
    const t = setup();
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(0, 900, "hello"));
    await advance(PASSAGE_FLUSH_INTERVAL_MS - 1000 - 1);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);

    await advance(1);
    const drafts = draftsOf(t.sender, "transcript.passages");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.data.passages).toHaveLength(1);

    await advance(PASSAGE_FLUSH_INTERVAL_MS);
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(1);
  });

  it("enqueues as soon as 50 passages wait", async () => {
    const t = setup();
    await startAndAdmit(t);

    for (const i of range(49)) t.stt.emitUtterance(utterance(i * 100, i * 100 + 50, `word${i}`));
    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);

    t.stt.emitUtterance(utterance(4900, 4950, "word49"));
    const drafts = draftsOf(t.sender, "transcript.passages");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.data.passages).toHaveLength(50);
  });

  it("leaves splitting above 50 to the sender", async () => {
    const t = setup();
    await startAndAdmit(t);

    for (const i of range(49)) t.stt.emitUtterance(utterance(i * 100, i * 100 + 50, `word${i}`));
    t.stt.emitUtterance(utterance(5000, 15000, words(500)));

    const drafts = draftsOf(t.sender, "transcript.passages");
    expect(drafts).toHaveLength(1);
    const passages = drafts[0]?.data.passages ?? [];
    expect(passages.length).toBeGreaterThan(50);
    expect(passages.map((passage) => passage.index)).toEqual(range(passages.length));
  });

  it("caps passages at 60 s and 1,000 characters", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.stt.emitUtterance(utterance(0, 150000, words(500)));
    await advance(PASSAGE_FLUSH_INTERVAL_MS);

    const passages = allPassages(t.sender);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(MAX_PASSAGE_TEXT_LENGTH);
      expect(passage.endMs - passage.startMs).toBeLessThanOrEqual(MAX_PASSAGE_DURATION_MS);
    }
    expect(passages.map((passage) => passage.index)).toEqual(range(passages.length));
  });

  it("each passage carries exactly one of speakerName and unknownSpeakerNumber", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.stt.emitUtterance(utterance(0, 900, "named"));
    t.attributor.next = UNKNOWN;
    t.stt.emitUtterance(utterance(1000, 1900, "unnamed"));
    await advance(PASSAGE_FLUSH_INTERVAL_MS);

    const passages = allPassages(t.sender);
    expect(passages).toHaveLength(2);
    expect(passages[0]).toMatchObject({
      speakerKey: "participant:p1",
      speakerName: "Example Person",
      unknownSpeakerNumber: null,
    });
    expect(passages[1]).toMatchObject({
      speakerKey: "unknown:1",
      speakerName: null,
      unknownSpeakerNumber: 1,
    });
    for (const passage of passages) {
      expect((passage.speakerName === null) !== (passage.unknownSpeakerNumber === null)).toBe(true);
    }
  });

  it("sends no passages event for blank speech", async () => {
    const t = setup();
    await startAndAdmit(t);

    t.stt.emitUtterance(utterance(0, 900, "   "));
    await advance(10000);
    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(draftsOf(t.sender, "transcript.passages")).toHaveLength(0);
    expect(ended(t.sender).passageCount).toBe(0);
  });

  it("stamps speaker signals with the transcript clock", async () => {
    const t = setup();
    t.runner.start();
    await settle();

    t.platform.emit({ type: "speaker", participantId: "p1", name: "Early Person", speaking: true });
    t.platform.emit({ type: "source_activity", sourceKey: "src-1", level: 0.5 });
    t.platform.emit({
      type: "source_identity",
      sourceKey: "src-1",
      participantId: "p1",
      name: "Early Person",
    });
    expect(t.attributor.speakerSamples).toEqual([]);
    expect(t.attributor.activitySamples).toEqual([]);
    expect(t.attributor.identities).toHaveLength(1);

    t.platform.emit({ type: "admitted" });
    t.platform.emit({ type: "participant_count", count: 2 });
    await advance(2500);
    t.platform.emit({ type: "speaker", participantId: "p2", name: "Later Person", speaking: true });
    t.platform.emit({ type: "source_activity", sourceKey: "src-2", level: 0.25 });
    t.platform.emit({
      type: "source_identity",
      sourceKey: "src-2",
      participantId: "p2",
      name: "Later Person",
    });

    expect(t.attributor.speakerSamples).toEqual([
      { atMs: 2500, participantId: "p2", name: "Later Person", speaking: true },
    ]);
    expect(t.attributor.activitySamples).toEqual([{ atMs: 2500, sourceKey: "src-2", level: 0.25 }]);
    expect(t.attributor.identities[1]).toEqual({
      sourceKey: "src-2",
      participantId: "p2",
      name: "Later Person",
    });

    t.stt.emitUtterance(utterance(1000, 2000, "hi", "S9"));
    expect(t.attributor.attributeCalls).toEqual([{ startMs: 1000, endMs: 2000, diarizationLabel: "S9" }]);
  });

  it("ends INTERRUPTED when the provider cannot start", async () => {
    const t = setup({ stt: { startError: new Error("no stt") } });

    await startAndAdmit(t);

    const data = ended(t.sender);
    expect(data.endReason).toBe("INTERRUPTED");
    expect(data.interruptedAtMs).toBe(0);
    expect(t.platform.reconnectCalls).toBe(0);
  });

  it("ends INTERRUPTED where the provider failed", async () => {
    const t = setup();
    await startAndAdmit(t);

    await advance(1000);
    t.stt.emitUtterance(utterance(0, 900, "hello"));
    await advance(6000);
    t.stt.emitError(new Error("x"));
    await settle();

    expect(ended(t.sender)).toEqual({
      endReason: "INTERRUPTED",
      durationMs: 7000,
      interruptedAtMs: 7000,
      passageCount: 1,
    });
    expect(draftsOf(t.sender, "session.reconnecting")).toHaveLength(0);
  });
});

describe("status", () => {
  it("reports every phase change", async () => {
    const t = setup();
    await startAndAdmit(t);
    t.platform.emit({ type: "meeting_ended" });
    await settle();

    const phases = t.statuses
      .map((status) => status.phase)
      .filter((phase, index, all) => index === 0 || phase !== all[index - 1]);
    expect(phases).toEqual(["STARTING", "WAITING", "IN_MEETING", "ENDED"]);
    expect(t.statuses[t.statuses.length - 1]).toEqual({
      phase: "ENDED",
      lastEventSequence: t.sender.lastAcceptedSequence,
    });
    expect(t.runner.getStatus()).toEqual(t.statuses[t.statuses.length - 1]);
  });

  it("reports a change of the last accepted sequence within one poll interval", async () => {
    const t = setup();
    t.sender.holdDelivery = true;
    t.runner.start();
    await settle();

    t.sender.deliverAll();
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(t.statuses[t.statuses.length - 1]).toEqual({
      phase: "WAITING",
      lastEventSequence: t.sender.drafts.length,
    });

    const count = t.statuses.length;
    await advance(10000);
    expect(t.statuses).toHaveLength(count);
  });

  it("a throwing listener does not break the runner", async () => {
    const t = setup({ throwingListener: true });
    await startAndAdmit(t);

    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(t.getSummary()).toEqual({ endReason: "MEETING_ENDED", passageCount: 0 });
    expect(t.statuses[t.statuses.length - 1]?.phase).toBe("ENDED");
  });

  it("exports the pinned constants", () => {
    expect([
      HEARTBEAT_INTERVAL_MS,
      PASSAGE_FLUSH_INTERVAL_MS,
      NOTICE_RETRY_INTERVAL_MS,
      NOTICE_DEADLINE_MS,
      REJOIN_TIMEOUT_MS,
      LEAVE_TIMEOUT_MS,
      STT_FLUSH_TIMEOUT_MS,
      ENDED_DELIVERY_TIMEOUT_MS,
      STATUS_POLL_INTERVAL_MS,
    ]).toEqual([30000, FIVE_SECONDS, FIVE_SECONDS, 30000, 60000, FIVE_SECONDS, 3000, 300000, 1000]);
  });
});

describe("audio and privacy", () => {
  const FS_WRITERS = [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "createWriteStream",
    "open",
    "openSync",
    "write",
    "writeSync",
    "mkdir",
    "mkdirSync",
  ] as const;
  const FS_PROMISE_WRITERS = ["writeFile", "appendFile", "open", "mkdir"] as const;

  it("forwards audio to the provider only and never to the app or the disk", async () => {
    const t = setup();
    const spies = [
      ...FS_WRITERS.map((name) => vi.spyOn(fs, name)),
      ...FS_PROMISE_WRITERS.map((name) => vi.spyOn(fs.promises, name)),
    ];
    t.runner.start();
    await settle();

    t.platform.emitAudio({ samples: new Int16Array(1600) });
    t.platform.emit({ type: "admitted" });
    t.platform.emit({ type: "participant_count", count: 2 });
    await advance(1000);
    t.platform.emitAudio({ samples: new Int16Array(1600) });
    t.stt.emitUtterance(utterance(0, 900, "hello"));
    await advance(PASSAGE_FLUSH_INTERVAL_MS);
    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(t.stt.receivedAudioMs).toBe(1100);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(t.sender.drafts.every((draft) => !containsBinary(draft))).toBe(true);
  });

  it("forwards no audio after the end", async () => {
    const t = setup();
    await startAndAdmit(t);
    await advance(1000);
    t.platform.emitAudio({ samples: new Int16Array(1600) });
    t.platform.emit({ type: "meeting_ended" });
    await settle();
    const receivedAudioMs = t.stt.receivedAudioMs;

    t.handlers().onAudioFrame({ samples: new Int16Array(1600) });
    await advance(1000);

    expect(t.stt.receivedAudioMs).toBe(receivedAudioMs);
  });

  it("logs no transcript text, name, notice or link", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const t = setup({ logger, platform: { postChatError: new Error("chat closed") } });
    t.attributor.next = {
      speakerKey: "participant:p9",
      speakerName: "Zelda Fitzgerald",
      unknownSpeakerNumber: null,
    };
    await startAndAdmit(t);

    t.platform.emit({ type: "speaker", participantId: "p9", name: "Zelda Fitzgerald", speaking: true });
    t.stt.emitUtterance(utterance(0, 900, "zebra quartz secret"));
    await advance(FIVE_SECONDS);
    t.platform.setPostChatError(null);
    await advance(FIVE_SECONDS);
    t.platform.emit({ type: "meeting_ended" });
    await settle();

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    for (const secret of [
      "zebra quartz secret",
      "Zelda Fitzgerald",
      t.request.noticeMessage,
      t.request.displayName,
      t.request.meetingUrl,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
