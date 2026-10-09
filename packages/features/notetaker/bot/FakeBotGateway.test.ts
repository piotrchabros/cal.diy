import { randomUUID } from "node:crypto";
import process from "node:process";
import type { NotetakerBotEvent, NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { notetakerBotEventSchema, notetakerBotJoinRequestSchema } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it } from "vitest";
import type { NotetakerFakeScenario } from "../lib/config";
import { getNotetakerConfig } from "../lib/config";
import { countTranscriptWords } from "../lib/transcriptWords";
import { StubSummaryGenerator } from "../summary/StubSummaryGenerator";
import { FakeBotGateway } from "./FakeBotGateway";
import type { NotetakerBotEventSink } from "./INotetakerBotGateway";
import { getNotetakerBotGatewayFailure } from "./INotetakerBotGateway";

function buildJoinRequest(overrides: Partial<NotetakerBotJoinRequest> = {}): NotetakerBotJoinRequest {
  return notetakerBotJoinRequestSchema.parse({
    sessionId: randomUUID(),
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Cal.diy Notetaker",
    noticeMessage: "This meeting is being transcribed.",
    scheduledStartAt: "2030-01-01T10:00:00.000Z",
    callbackUrl: "https://example.com/api/notetaker/events",
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 300,
      maxDurationSeconds: 7200,
    },
    ...overrides,
  });
}

function setup(scenario: NotetakerFakeScenario) {
  const events: NotetakerBotEvent[] = [];
  const sink: NotetakerBotEventSink = async (event) => {
    events.push(event);
  };
  const gateway = new FakeBotGateway({ scenario, eventSink: sink });
  return { events, gateway };
}

async function run(scenario: NotetakerFakeScenario, request = buildJoinRequest()) {
  const { events, gateway } = setup(scenario);
  await gateway.requestJoin(request);
  await gateway.whenIdle();
  return { events, gateway, request };
}

const SCRIPTED: [NotetakerFakeScenario, string[]][] = [
  [
    "happy",
    [
      "session.join_requested",
      "session.admitted",
      "session.notice_posted",
      "transcript.passages",
      "transcript.passages",
      "session.ended",
    ],
  ],
  ["not_admitted", ["session.join_requested", "session.ended"]],
  ["meeting_did_not_start", ["session.join_requested", "session.ended"]],
  ["no_speech", ["session.join_requested", "session.admitted", "session.notice_posted", "session.ended"]],
  [
    "removed_by_participant",
    [
      "session.join_requested",
      "session.admitted",
      "session.notice_posted",
      "transcript.passages",
      "session.ended",
    ],
  ],
  [
    "interrupted",
    [
      "session.join_requested",
      "session.admitted",
      "session.notice_posted",
      "transcript.passages",
      "session.reconnecting",
      "session.ended",
    ],
  ],
  [
    "length_limit",
    [
      "session.join_requested",
      "session.admitted",
      "session.notice_posted",
      "transcript.passages",
      "session.ended",
    ],
  ],
];

function endedEvents(events: NotetakerBotEvent[]) {
  return events.flatMap((event) => (event.type === "session.ended" ? [event] : []));
}

function passageEvents(events: NotetakerBotEvent[]) {
  return events.flatMap((event) => (event.type === "transcript.passages" ? [event] : []));
}

describe("FakeBotGateway", () => {
  describe.each(SCRIPTED)("scenario %s", (scenario, expectedTypes) => {
    it("emits the scripted event types in order", async () => {
      const { events } = await run(scenario);
      expect(events.map((event) => event.type)).toEqual(expectedTypes);
    });

    it("emits events that satisfy the bot event schema", async () => {
      const { events } = await run(scenario);
      for (const event of events) {
        expect(notetakerBotEventSchema.safeParse(event).success).toBe(true);
      }
    });

    it("emits a consistent envelope", async () => {
      const { events, request } = await run(scenario);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
      for (const event of events) {
        expect(event.sessionId).toBe(request.sessionId);
      }
      const times = events.map((event) => Date.parse(event.occurredAt));
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    });
  });

  it("happy: emits known and unknown speakers and a matching passage count", async () => {
    const { events } = await run("happy");
    const passages = passageEvents(events).flatMap((event) => event.data.passages);

    const names = new Set(passages.flatMap((p) => (p.speakerName === null ? [] : [p.speakerName])));
    expect(names.size).toBeGreaterThanOrEqual(2);
    expect(passages.some((p) => p.speakerName === null && p.unknownSpeakerNumber === 1)).toBe(true);
    expect(passages.map((p) => p.index)).toEqual([0, 1, 2]);

    const [ended] = endedEvents(events);
    expect(ended.data.endReason).toBe("MEETING_ENDED");
    expect(ended.data.passageCount).toBe(passages.length);
  });

  it("no_speech: emits no passages and reports zero", async () => {
    const { events } = await run("no_speech");
    expect(passageEvents(events)).toHaveLength(0);
    expect(endedEvents(events)[0].data.passageCount).toBe(0);
  });

  it("interrupted: ended carries the reconnecting offset", async () => {
    const { events } = await run("interrupted");
    const reconnecting = events.flatMap((event) => (event.type === "session.reconnecting" ? [event] : []));
    expect(reconnecting).toHaveLength(1);
    const [ended] = endedEvents(events);
    expect(ended.data.endReason).toBe("INTERRUPTED");
    expect(ended.data.interruptedAtMs).toBe(reconnecting[0].data.atMs);
  });

  it("length_limit: duration equals the configured maximum", async () => {
    const request = buildJoinRequest({
      limits: {
        admissionTimeoutSeconds: 600,
        noShowTimeoutSeconds: 900,
        aloneTimeoutSeconds: 300,
        maxDurationSeconds: 1800,
      },
    });
    const { events } = await run("length_limit", request);
    const [ended] = endedEvents(events);
    expect(ended.data.endReason).toBe("LENGTH_LIMIT_REACHED");
    expect(ended.data.durationMs).toBe(1800 * 1000);
  });

  it.each<NotetakerFakeScenario>([
    "not_admitted",
    "meeting_did_not_start",
  ])("%s: never admits the bot", async (scenario) => {
    const { events } = await run(scenario);
    expect(events.some((event) => event.type === "session.admitted")).toBe(false);
  });

  it("link_unusable: rejects the join, records the request and emits nothing", async () => {
    const { events, gateway } = setup("link_unusable");
    const request = buildJoinRequest();

    const error = await gateway.requestJoin(request).then(
      () => null,
      (e: unknown) => e
    );

    expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    await gateway.whenIdle();
    expect(events).toHaveLength(0);
    expect(gateway.joinRequests).toEqual([request]);
    expect(await gateway.getState(request.sessionId)).toBeNull();
  });

  it("manual: returns an externalRef and emits nothing", async () => {
    const { events, gateway } = setup("manual");
    const result = await gateway.requestJoin(buildJoinRequest());
    await gateway.whenIdle();
    expect(result.externalRef).toBeTruthy();
    expect(events).toHaveLength(0);
  });

  it("records join and stop requests in order", async () => {
    const { gateway } = setup("manual");
    const first = buildJoinRequest();
    const second = buildJoinRequest();
    await gateway.requestJoin(first);
    await gateway.requestJoin(second);
    await expect(
      gateway.requestStop({ sessionId: first.sessionId, reason: "STOPPED_BY_HOST" })
    ).resolves.toBeUndefined();
    await gateway.requestStop({ sessionId: second.sessionId, reason: "DISABLED" });

    expect(gateway.joinRequests).toEqual([first, second]);
    expect(gateway.stopRequests).toEqual([
      { sessionId: first.sessionId, reason: "STOPPED_BY_HOST" },
      { sessionId: second.sessionId, reason: "DISABLED" },
    ]);
  });

  it("joining the same session twice returns the same ref and runs the script once", async () => {
    const { events, gateway } = setup("happy");
    const request = buildJoinRequest();
    const first = await gateway.requestJoin(request);
    const second = await gateway.requestJoin(request);
    await gateway.whenIdle();

    expect(second.externalRef).toBe(first.externalRef);
    expect(gateway.joinRequests).toHaveLength(2);
    expect(events).toHaveLength(6);
  });

  it("does not emit before the join call has resolved", async () => {
    const { events, gateway } = setup("happy");
    await gateway.requestJoin(buildJoinRequest());
    expect(events).toHaveLength(0);
    await gateway.whenIdle();
    expect(events).toHaveLength(6);
  });

  it("getState reports null for unknown sessions and ENDED after the script", async () => {
    const { gateway } = setup("happy");
    expect(await gateway.getState("unknown")).toBeNull();

    const request = buildJoinRequest();
    await gateway.requestJoin(request);
    expect(await gateway.getState(request.sessionId)).toEqual({
      sessionId: request.sessionId,
      phase: "STARTING",
      lastEventSequence: 0,
    });
    await gateway.whenIdle();
    expect(await gateway.getState(request.sessionId)).toEqual({
      sessionId: request.sessionId,
      phase: "ENDED",
      lastEventSequence: 6,
    });
  });

  it("captures a rejecting sink in scriptErrors and stops emitting", async () => {
    const failure = new Error("sink down");
    let calls = 0;
    const sink: NotetakerBotEventSink = async () => {
      calls += 1;
      if (calls === 2) throw failure;
    };
    const gateway = new FakeBotGateway({ scenario: "happy", eventSink: sink });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await gateway.requestJoin(buildJoinRequest());
      await gateway.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(gateway.scriptErrors).toEqual([failure]);
    expect(calls).toBe(2);
    expect(unhandled).toHaveLength(0);
  });

  it("the happy script carries at least the default minimum of words", async () => {
    const { events } = await run("happy");
    const passages = passageEvents(events).flatMap((event) => event.data.passages);

    expect(countTranscriptWords(passages)).toBeGreaterThanOrEqual(
      getNotetakerConfig({ NODE_ENV: "test" }).limits.summaryMinWords
    );
  });

  it("the stub summary of the happy script has all four sections", async () => {
    const { events } = await run("happy");
    const passages = passageEvents(events).flatMap((event) => event.data.passages);

    const result = await new StubSummaryGenerator().generate({ passages, languageHint: null });

    if (!result.ok) throw new Error(`stub summary failed: ${result.failureCode}`);
    expect(result.content.overview.length).toBeGreaterThan(0);
    expect(result.content.keyPoints.length).toBeGreaterThan(0);
    expect(result.content.decisions.length).toBeGreaterThan(0);
    expect(result.content.actionItems.length).toBeGreaterThan(0);
  });
});
