import { describe, expect, it } from "vitest";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_SIGNATURE_TOLERANCE_SECONDS,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotEndReasonSchema,
  notetakerBotEventSchema,
  notetakerBotJoinRequestSchema,
  notetakerBotJoinResponseSchema,
  notetakerBotPassageSchema,
  notetakerBotStateSchema,
  notetakerBotStopReasonSchema,
  notetakerBotStopRequestSchema,
  signNotetakerPayload,
  verifyNotetakerSignature,
} from "./botContract";

const SECRET = "test-secret";
const NOW = 1893492000;
const RAW_BODY = JSON.stringify({ reason: "STOPPED_BY_HOST" });

const envelope = {
  eventId: "00000000-0000-4000-8000-000000000001",
  sessionId: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
  occurredAt: "2030-01-01T10:00:05.000Z",
};

const namedPassage = {
  index: 0,
  speakerKey: "speaker-1",
  speakerName: "Example Person",
  unknownSpeakerNumber: null,
  startMs: 1000,
  endMs: 6500,
  text: "Example passage text.",
  language: "en",
};

const unknownPassage = {
  index: 1,
  speakerKey: "speaker-2",
  speakerName: null,
  unknownSpeakerNumber: 1,
  startMs: 6800,
  endMs: 9200,
  text: "Another example passage.",
  language: null,
};

const endedData = {
  endReason: "MEETING_ENDED",
  durationMs: 2630000,
  interruptedAtMs: null,
  passageCount: 312,
};

const joinRequest = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  platform: "GOOGLE_MEET",
  meetingUrl: "https://meet.example.test/abc-defg-hij",
  displayName: "Example Notetaker for Jane Host",
  noticeMessage: "This meeting is being transcribed by an automated notetaker on behalf of Jane Host.",
  scheduledStartAt: "2030-01-01T10:00:00.000Z",
  callbackUrl: "https://app.example.test/api/notetaker/events",
  limits: {
    admissionTimeoutSeconds: 600,
    noShowTimeoutSeconds: 900,
    aloneTimeoutSeconds: 120,
    maxDurationSeconds: 14400,
  },
};

function sign(overrides: Partial<{ secret: string; timestamp: number | string; rawBody: string }> = {}) {
  return signNotetakerPayload({ secret: SECRET, timestamp: NOW, rawBody: RAW_BODY, ...overrides });
}

function verify(
  overrides: Partial<{
    secret: string;
    timestamp: string | null | undefined;
    signature: string | null | undefined;
    rawBody: string;
    nowSeconds: number;
  }> = {}
) {
  return verifyNotetakerSignature({
    secret: SECRET,
    timestamp: String(NOW),
    signature: sign(),
    rawBody: RAW_BODY,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe("notetaker signing", () => {
  it("exposes the header names and tolerance of the contract", () => {
    expect(NOTETAKER_TIMESTAMP_HEADER).toBe("X-Notetaker-Timestamp");
    expect(NOTETAKER_SIGNATURE_HEADER).toBe("X-Notetaker-Signature");
    expect(NOTETAKER_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it("produces sha256=<hex> over <timestamp>.<rawBody>", () => {
    expect(sign()).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign({ timestamp: String(NOW) })).toBe(sign({ timestamp: NOW }));
    expect(sign({ timestamp: NOW + 1 })).not.toBe(sign());
  });

  it("verifies a signature made with the same secret, timestamp and body", () => {
    expect(verify()).toBe(true);
  });

  it("defaults the clock to the current time", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(
      verifyNotetakerSignature({
        secret: SECRET,
        timestamp: String(timestamp),
        signature: sign({ timestamp }),
        rawBody: RAW_BODY,
      })
    ).toBe(true);
    expect(
      verifyNotetakerSignature({
        secret: SECRET,
        timestamp: String(NOW),
        signature: sign(),
        rawBody: RAW_BODY,
      })
    ).toBe(false);
  });

  it("fails on a changed body", () => {
    expect(verify({ rawBody: `${RAW_BODY} ` })).toBe(false);
  });

  it("fails on a wrong secret", () => {
    expect(verify({ secret: "other-secret" })).toBe(false);
    expect(verify({ signature: sign({ secret: "other-secret" }) })).toBe(false);
  });

  it("fails on an empty secret", () => {
    expect(verify({ secret: "", signature: sign({ secret: "" }) })).toBe(false);
  });

  it("fails on a timestamp that differs from the signed one", () => {
    expect(verify({ timestamp: String(NOW + 1) })).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["without the scheme prefix", sign().slice("sha256=".length)],
    ["with another scheme", sign().replace("sha256=", "sha1=")],
    ["with truncated hex", sign().slice(0, -2)],
    ["with non-hex characters", `sha256=${"z".repeat(64)}`],
    ["with trailing characters", `${sign()}00`],
  ])("fails on a signature header that is %s", (_label, signature) => {
    expect(verify({ signature })).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["not a number", "soon"],
    ["a decimal", `${NOW}.5`],
    ["negative", `-${NOW}`],
  ])("fails on a timestamp header that is %s", (_label, timestamp) => {
    const signature = typeof timestamp === "string" ? sign({ timestamp }) : sign();
    expect(verify({ timestamp, signature })).toBe(false);
  });

  it("accepts a timestamp exactly 300 seconds off and rejects 301 in either direction", () => {
    expect(verify({ nowSeconds: NOW + 300 })).toBe(true);
    expect(verify({ nowSeconds: NOW - 300 })).toBe(true);
    expect(verify({ nowSeconds: NOW + 301 })).toBe(false);
    expect(verify({ nowSeconds: NOW - 301 })).toBe(false);
  });

  it("signs an empty body as <timestamp>.", () => {
    const signature = sign({ rawBody: "" });
    // Computed outside the helper: printf '1893492000.' | openssl dgst -sha256 -hmac test-secret
    expect(signature).toBe("sha256=ca4157bda169d48470de7ac0a2a65c97bbd36a2bc575d8e8fa7f0fa4e29fc9b4");
    expect(verify({ rawBody: "", signature })).toBe(true);
    expect(verify({ rawBody: "", signature: sign() })).toBe(false);
  });
});

describe("notetakerBotEventSchema", () => {
  const events = [
    { ...envelope, type: "session.join_requested", data: {} },
    { ...envelope, type: "session.admitted", data: {} },
    { ...envelope, type: "session.notice_posted", data: {} },
    { ...envelope, type: "session.heartbeat", data: { participantCount: 3 } },
    { ...envelope, type: "session.reconnecting", data: { atMs: 1130000 } },
    { ...envelope, type: "transcript.passages", data: { passages: [namedPassage, unknownPassage] } },
    { ...envelope, type: "session.ended", data: endedData },
  ];

  it.each(events.map((event) => [event.type, event] as const))("parses %s", (_type, event) => {
    expect(notetakerBotEventSchema.parse(event)).toEqual(event);
  });

  it("covers seven event types", () => {
    expect(new Set(events.map((event) => event.type)).size).toBe(7);
  });

  it("rejects an unknown type", () => {
    expect(notetakerBotEventSchema.safeParse({ ...envelope, type: "session.paused", data: {} }).success).toBe(
      false
    );
  });

  it("rejects data that belongs to another type", () => {
    expect(
      notetakerBotEventSchema.safeParse({ ...envelope, type: "session.heartbeat", data: {} }).success
    ).toBe(false);
    expect(
      notetakerBotEventSchema.safeParse({ ...envelope, type: "session.ended", data: { participantCount: 3 } })
        .success
    ).toBe(false);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "1"],
  ])("rejects a sequence that is %s", (_label, sequence) => {
    expect(
      notetakerBotEventSchema.safeParse({ ...envelope, sequence, type: "session.admitted", data: {} }).success
    ).toBe(false);
  });

  it("rejects an eventId that is not a uuid", () => {
    expect(
      notetakerBotEventSchema.safeParse({ ...envelope, eventId: "evt-1", type: "session.admitted", data: {} })
        .success
    ).toBe(false);
  });

  it("rejects an occurredAt that is not an ISO 8601 UTC timestamp", () => {
    expect(
      notetakerBotEventSchema.safeParse({
        ...envelope,
        occurredAt: "2030-01-01 10:00:05",
        type: "session.admitted",
        data: {},
      }).success
    ).toBe(false);
  });

  it("accepts 50 passages and rejects 51", () => {
    const passages = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({ ...namedPassage, index }));
    const event = (count: number) => ({
      ...envelope,
      type: "transcript.passages",
      data: { passages: passages(count) },
    });

    expect(notetakerBotEventSchema.safeParse(event(50)).success).toBe(true);
    expect(notetakerBotEventSchema.safeParse(event(51)).success).toBe(false);
  });

  it("rejects an invalid passage inside an event", () => {
    expect(
      notetakerBotEventSchema.safeParse({
        ...envelope,
        type: "transcript.passages",
        data: { passages: [{ ...namedPassage, text: "" }] },
      }).success
    ).toBe(false);
  });

  it("accepts a null and a numeric interruptedAtMs on session.ended", () => {
    const ended = (interruptedAtMs: number | null) => ({
      ...envelope,
      type: "session.ended",
      data: { ...endedData, endReason: "INTERRUPTED", interruptedAtMs },
    });

    expect(notetakerBotEventSchema.safeParse(ended(null)).success).toBe(true);
    expect(notetakerBotEventSchema.safeParse(ended(1130000)).success).toBe(true);
  });
});

describe("notetakerBotPassageSchema", () => {
  it("parses a named and an unknown-speaker passage", () => {
    expect(notetakerBotPassageSchema.parse(namedPassage)).toEqual(namedPassage);
    expect(notetakerBotPassageSchema.parse(unknownPassage)).toEqual(unknownPassage);
  });

  it("accepts text of 1 and of 1,000 characters", () => {
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, text: "a" }).success).toBe(true);
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, text: "a".repeat(1000) }).success).toBe(
      true
    );
  });

  it("rejects empty text and text longer than 1,000 characters", () => {
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, text: "" }).success).toBe(false);
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, text: "a".repeat(1001) }).success).toBe(
      false
    );
  });

  it("accepts endMs equal to startMs and rejects endMs before startMs", () => {
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, startMs: 1000, endMs: 1000 }).success).toBe(
      true
    );
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, startMs: 1000, endMs: 999 }).success).toBe(
      false
    );
  });

  it("rejects a passage with both a speaker name and an unknown-speaker number", () => {
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, unknownSpeakerNumber: 1 }).success).toBe(
      false
    );
  });

  it("rejects a passage with neither a speaker name nor an unknown-speaker number", () => {
    expect(notetakerBotPassageSchema.safeParse({ ...namedPassage, speakerName: null }).success).toBe(false);
  });
});

describe("notetakerBotEndReasonSchema", () => {
  it("accepts exactly the nine wire values", () => {
    expect([...notetakerBotEndReasonSchema.options].sort()).toEqual(
      [
        "MEETING_ENDED",
        "ALONE_TIMEOUT",
        "NOT_ADMITTED",
        "MEETING_DID_NOT_START",
        "REMOVED_BY_PARTICIPANT",
        "STOP_REQUESTED",
        "INTERRUPTED",
        "LENGTH_LIMIT_REACHED",
        "MEETING_LINK_UNUSABLE",
      ].sort()
    );
  });

  it("rejects outcome reasons that are not wire values", () => {
    expect(notetakerBotEndReasonSchema.safeParse("STOPPED_BY_HOST").success).toBe(false);
    expect(notetakerBotEndReasonSchema.safeParse("NO_SPEECH_DETECTED").success).toBe(false);
  });
});

describe("notetakerBotJoinRequestSchema", () => {
  it("parses the contract example", () => {
    expect(notetakerBotJoinRequestSchema.parse(joinRequest)).toEqual(joinRequest);
  });

  it.each([
    "admissionTimeoutSeconds",
    "noShowTimeoutSeconds",
    "aloneTimeoutSeconds",
    "maxDurationSeconds",
  ] as const)("requires limits.%s", (field) => {
    const { [field]: _omitted, ...limits } = joinRequest.limits;
    expect(notetakerBotJoinRequestSchema.safeParse({ ...joinRequest, limits }).success).toBe(false);
  });

  it("requires limits", () => {
    const { limits: _omitted, ...withoutLimits } = joinRequest;
    expect(notetakerBotJoinRequestSchema.safeParse(withoutLimits).success).toBe(false);
  });

  it("accepts only the two supported platforms", () => {
    expect(
      notetakerBotJoinRequestSchema.safeParse({ ...joinRequest, platform: "MICROSOFT_TEAMS" }).success
    ).toBe(true);
    expect(notetakerBotJoinRequestSchema.safeParse({ ...joinRequest, platform: "ZOOM" }).success).toBe(false);
  });
});

describe("notetaker stop and state schemas", () => {
  it("accepts only the three stop reasons", () => {
    expect([...notetakerBotStopReasonSchema.options].sort()).toEqual(
      ["STOPPED_BY_HOST", "BOOKING_NOT_ACTIVE", "DISABLED"].sort()
    );
    expect(notetakerBotStopRequestSchema.safeParse({ reason: "DISABLED" }).success).toBe(true);
    expect(notetakerBotStopRequestSchema.safeParse({ reason: "STOP_REQUESTED" }).success).toBe(false);
    expect(notetakerBotStopRequestSchema.safeParse({}).success).toBe(false);
  });

  it("parses the join response", () => {
    const response = { sessionId: joinRequest.sessionId, externalRef: "fake-ref-0001" };
    expect(notetakerBotJoinResponseSchema.parse(response)).toEqual(response);
    expect(notetakerBotJoinResponseSchema.safeParse({ sessionId: joinRequest.sessionId }).success).toBe(
      false
    );
  });

  it("parses the bot state and rejects an unknown phase", () => {
    const state = { sessionId: joinRequest.sessionId, phase: "IN_MEETING", lastEventSequence: 7 };
    expect(notetakerBotStateSchema.parse(state)).toEqual(state);
    expect(notetakerBotStateSchema.safeParse({ ...state, phase: "PAUSED" }).success).toBe(false);
  });
});
