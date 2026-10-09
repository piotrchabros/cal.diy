// @vitest-environment node

import type { NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import { notetakerBotEndReasonSchema, notetakerBotEventSchema } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it } from "vitest";
import {
  buildFakeEventRequests,
  buildFakeEvents,
  deterministicEventId,
  FAKE_EVENTS_USAGE,
  type FakeEventsOptions,
  type FakeEventsStage,
  parseFakeEventsArgs,
  resolveFakeEventsUrl,
} from "./fakeEventsPlan";

const SESSION_ID = "6f1c2f0e-8f43-4a43-9a53-0d3a4f1b7c11";
const NOW = new Date("2030-01-01T10:00:00.000Z");

const options = (overrides: Partial<FakeEventsOptions> = {}): FakeEventsOptions => ({
  sessionId: SESSION_ID,
  until: "ended",
  endReason: "MEETING_ENDED",
  skipPassages: false,
  badSignature: false,
  replayLast: false,
  timestampOffsetSeconds: 0,
  url: null,
  envFile: null,
  help: false,
  ...overrides,
});

const sequences = (events: NotetakerBotEvent[]) => events.map((event) => event.sequence);
const types = (events: NotetakerBotEvent[]) => events.map((event) => event.type);

describe("parseFakeEventsArgs", () => {
  it("applies the defaults when only --session is given", () => {
    expect(parseFakeEventsArgs(["--session", SESSION_ID])).toEqual({
      sessionId: SESSION_ID,
      until: "ended",
      endReason: "MEETING_ENDED",
      skipPassages: false,
      badSignature: false,
      replayLast: false,
      timestampOffsetSeconds: 0,
      url: null,
      envFile: null,
      help: false,
    });
  });

  it("parses every flag", () => {
    expect(
      parseFakeEventsArgs([
        "--session",
        "abc",
        "--until",
        "passages",
        "--end-reason",
        "STOP_REQUESTED",
        "--skip-passages",
        "--bad-signature",
        "--replay-last",
        "--timestamp-offset=-400",
        "--url",
        "https://example.com/api/notetaker/events",
        "--env-file",
        "/tmp/some.env",
      ])
    ).toEqual({
      sessionId: "abc",
      until: "passages",
      endReason: "STOP_REQUESTED",
      skipPassages: true,
      badSignature: true,
      replayLast: true,
      timestampOffsetSeconds: -400,
      url: "https://example.com/api/notetaker/events",
      envFile: "/tmp/some.env",
      help: false,
    });
  });

  it("parses a positive timestamp offset given as a separate value", () => {
    expect(
      parseFakeEventsArgs(["--session", "abc", "--timestamp-offset", "400"]).timestampOffsetSeconds
    ).toBe(400);
  });

  it("returns help without requiring --session", () => {
    const parsed = parseFakeEventsArgs(["--help"]);

    expect(parsed.help).toBe(true);
    expect(parsed.sessionId).toBe("");
    expect(parsed.until).toBe("ended");
    expect(parsed.endReason).toBe("MEETING_ENDED");
  });

  it.each([
    ["a missing --session", []],
    ["an empty session", ["--session", ""]],
    ["an unknown flag", ["--session", "abc", "--nope"]],
    ["a positional argument", ["--session", "abc", "extra"]],
    ["a bad --until", ["--session", "abc", "--until", "later"]],
    ["a bad --end-reason", ["--session", "abc", "--end-reason", "BORED"]],
    ["a non-integer offset", ["--session", "abc", "--timestamp-offset", "1.5"]],
    ["a non-numeric offset", ["--session", "abc", "--timestamp-offset", "soon"]],
    ["a non-http url", ["--session", "abc", "--url", "ftp://example.com/events"]],
    ["a flag missing its value", ["--session", "abc", "--until"]],
  ])("throws for %s", (_name, argv) => {
    expect(() => parseFakeEventsArgs(argv)).toThrow(Error);
  });

  it("lists the allowed values when --end-reason is bad", () => {
    let message = "";
    try {
      parseFakeEventsArgs(["--session", "abc", "--end-reason", "BORED"]);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    for (const reason of notetakerBotEndReasonSchema.options) {
      expect(message).toContain(reason);
    }
  });
});

describe("FAKE_EVENTS_USAGE", () => {
  it("names every flag and the secret variable", () => {
    for (const token of [
      "--session",
      "--until",
      "--end-reason",
      "--skip-passages",
      "--bad-signature",
      "--replay-last",
      "--timestamp-offset",
      "--url",
      "--env-file",
      "--help",
      "NOTETAKER_BOT_SECRET",
    ]) {
      expect(FAKE_EVENTS_USAGE).toContain(token);
    }
  });
});

describe("buildFakeEvents", () => {
  it("stops after admission with --until admitted", () => {
    const events = buildFakeEvents(options({ until: "admitted" }), NOW);

    expect(types(events)).toEqual(["session.join_requested", "session.admitted"]);
    expect(sequences(events)).toEqual([1, 2]);
  });

  it("includes the notice and the passages with --until passages", () => {
    const events = buildFakeEvents(options({ until: "passages" }), NOW);

    expect(sequences(events)).toEqual([1, 2, 3, 4]);
    const passagesEvent = events[3];
    if (passagesEvent?.type !== "transcript.passages")
      throw new Error("expected passages as the fourth event");
    const { passages } = passagesEvent.data;
    expect(passages).toHaveLength(3);
    expect(passages.map((passage) => passage.index)).toEqual([0, 1, 2]);
    expect(passages[0]?.speakerName).toEqual(expect.any(String));
    expect(passages[0]?.unknownSpeakerNumber).toBeNull();
    expect(passages[1]?.speakerName).toEqual(expect.any(String));
    expect(passages[1]?.unknownSpeakerNumber).toBeNull();
    expect(passages[2]?.speakerName).toBeNull();
    expect(passages[2]?.unknownSpeakerNumber).toBe(1);
    expect(passages[2]?.speakerKey).toBe("unknown:1");
  });

  it("ends the session with --until ended", () => {
    const events = buildFakeEvents(options({ until: "ended" }), NOW);

    expect(sequences(events)).toEqual([1, 2, 3, 4, 5]);
    expect(events[4]).toMatchObject({
      type: "session.ended",
      data: { endReason: "MEETING_ENDED", durationMs: 12000, interruptedAtMs: null, passageCount: 3 },
    });
  });

  it("carries the end reason into the end event", () => {
    const events = buildFakeEvents(options({ endReason: "STOP_REQUESTED" }), NOW);

    expect(events[4]).toMatchObject({ type: "session.ended", data: { endReason: "STOP_REQUESTED" } });
  });

  it("leaves out the passages but keeps the other sequence numbers with --skip-passages", () => {
    const ended = buildFakeEvents(options({ until: "ended", skipPassages: true }), NOW);

    expect(sequences(ended)).toEqual([1, 2, 3, 5]);
    expect(ended[3]).toMatchObject({ type: "session.ended", data: { passageCount: 0 } });
    expect(sequences(buildFakeEvents(options({ until: "passages", skipPassages: true }), NOW))).toEqual([
      1, 2, 3,
    ]);
  });

  it.each([
    ["admitted", false],
    ["admitted", true],
    ["passages", false],
    ["passages", true],
    ["ended", false],
    ["ended", true],
  ] as [
    FakeEventsStage,
    boolean,
  ][])("builds schema-valid events for %s (skipPassages %s)", (until, skipPassages) => {
    const events = buildFakeEvents(options({ until, skipPassages }), NOW);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(() => notetakerBotEventSchema.parse(event)).not.toThrow();
      expect(event.sessionId).toBe(SESSION_ID);
    }
  });

  it("stamps every event with the given time", () => {
    for (const event of buildFakeEvents(options(), NOW)) {
      expect(event.occurredAt).toBe(NOW.toISOString());
    }
  });

  it("derives the event ids from the session and sequence", () => {
    for (const event of buildFakeEvents(options(), NOW)) {
      expect(event.eventId).toBe(deterministicEventId(SESSION_ID, event.sequence));
    }
  });

  // A later run with a longer --until must re-send the same ids so the server dedupes the prefix.
  it("keeps the event ids of a shorter stage as a prefix of a longer one", () => {
    const shorter = buildFakeEvents(options({ until: "passages" }), NOW).map((event) => event.eventId);
    const longer = buildFakeEvents(options({ until: "ended" }), NOW).map((event) => event.eventId);

    expect(shorter).toEqual(longer.slice(0, 4));
  });
});

describe("deterministicEventId", () => {
  it("is stable for the same input", () => {
    expect(deterministicEventId("s1", 1)).toBe(deterministicEventId("s1", 1));
  });

  it("differs by sequence and by session", () => {
    expect(deterministicEventId("s1", 1)).not.toBe(deterministicEventId("s1", 2));
    expect(deterministicEventId("s1", 1)).not.toBe(deterministicEventId("s2", 1));
  });

  it("is shaped like a version 4 uuid", () => {
    for (let sequence = 1; sequence <= 20; sequence++) {
      expect(deterministicEventId(SESSION_ID, sequence)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
  });
});

describe("buildFakeEventRequests", () => {
  it("serializes each event once", () => {
    const requests = buildFakeEventRequests(options(), NOW);
    const events = buildFakeEvents(options(), NOW);

    expect(requests).toHaveLength(events.length);
    requests.forEach((request, index) => {
      const event = events[index];
      expect(request.sequence).toBe(event?.sequence);
      expect(request.type).toBe(event?.type);
      expect(JSON.parse(request.rawBody)).toEqual(event);
    });
  });

  it("appends the last request again with an identical body for --replay-last", () => {
    const requests = buildFakeEventRequests(options({ replayLast: true }), NOW);
    const plain = buildFakeEventRequests(options(), NOW);

    expect(requests).toHaveLength(plain.length + 1);
    const last = requests[requests.length - 1];
    const beforeLast = requests[requests.length - 2];
    expect(last?.rawBody).toBe(beforeLast?.rawBody);
    expect(last?.sequence).toBe(beforeLast?.sequence);
    expect(last?.type).toBe(beforeLast?.type);
  });
});

describe("resolveFakeEventsUrl", () => {
  it("prefers --url", () => {
    expect(resolveFakeEventsUrl(options({ url: "https://x.test/events" }), "https://app.test")).toBe(
      "https://x.test/events"
    );
  });

  it("uses the web app url without a trailing slash", () => {
    expect(resolveFakeEventsUrl(options(), "https://app.test/")).toBe(
      "https://app.test/api/notetaker/events"
    );
  });

  it("falls back to localhost", () => {
    expect(resolveFakeEventsUrl(options(), undefined)).toBe("http://localhost:3000/api/notetaker/events");
  });
});
